import { createHash } from 'crypto';
import { ContractState } from './types';

const notImplemented =
    (name: string) =>
        () => {
            throw new Error('method not implemented: ' + name);
        };

const prohibitedInView =
    (name: string) =>
        () => {
            throw new Error('method not available for view calls: ' + name);
        };

interface RuntimeCtx {
    contractId: string, contractState: ContractState, blockHeight: number, blockTimestamp: number, methodArgs: string
}
interface RuntimeConstructorArgs extends RuntimeCtx {
    // base64 encoded contract code
    contractCode: string,
}
export class Runtime {
    context: RuntimeCtx;
    wasm: Buffer;
    memory: WebAssembly.Memory;
    registers: Record<string, any>;
    logs: any[];
    result: Buffer;

    constructor({ contractCode, ...context }: RuntimeConstructorArgs) {
        this.context = context;
        this.wasm = this.prepareWASM(Buffer.from(contractCode, 'base64'));
        this.memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048 });
        this.registers = {};
        this.logs = [];
        this.result = Buffer.from([]);
    }

    private readUTF16CStr(ptr: bigint) {
        const arr: number[] = [];
        const mem = new Uint16Array(this.memory.buffer);
        let key = Number(ptr) / 2;
        while (mem[key] != 0) {
            arr.push(mem[key]);
            key++;
        }
        return Buffer.from(Uint16Array.from(arr).buffer).toString('ucs2');
    }

    private readUTF8CStr(len: bigint, ptr: bigint) {
        const arr: number[] = [];
        const mem = new Uint8Array(this.memory.buffer);
        let key = Number(ptr);
        for (let i = 0; i < len && mem[key] != 0; i++) {
            arr.push(mem[key]);
            key++;
        }
        return Buffer.from(arr).toString('utf8');
    }

    private storageRead(keyLen: bigint, keyPtr: bigint) {
        const storageKey = Buffer.from(new Uint8Array(this.memory.buffer, Number(keyPtr), Number(keyLen)));

        const stateVal = this.context.contractState.filter((obj) => Buffer.compare(obj.key, storageKey) === 0).map((obj) => obj.value);
        
        if (stateVal.length === 0) return null;

        return stateVal.length > 1 ? stateVal : stateVal[0];
    }

    private prepareWASM(input: Buffer) {
        const parts = [] as Buffer[];

        const magic = input.subarray(0, 4);

        if (magic.toString('utf8') !== '\0asm') {
            throw new Error('Invalid magic number');
        }

        const version = input.readUInt32LE(4);
        if (version != 1) {
            throw new Error('Invalid version: ' + version);
        }

        let offset = 8;
        parts.push(input.subarray(0, offset));

        function decodeLEB128() {
            let result = 0;
            let shift = 0;
            let byte: number;
            do {
                byte = input[offset++];
                result |= (byte & 0x7f) << shift;
                shift += 7;
            } while (byte & 0x80);
            return result;
        }

        function decodeLimits() {
            const flags = input[offset++];
            const hasMax = flags & 0x1;
            const initial = decodeLEB128();
            const max = hasMax ? decodeLEB128() : null;
            return { initial, max };
        }

        function decodeString() {
            const length = decodeLEB128();
            const result = input.subarray(offset, offset + length);
            offset += length;
            return result.toString('utf8');
        }

        function encodeLEB128(value: number) {
            const result: number[] = [];
            do {
                let byte = value & 0x7f;
                value >>= 7;
                if (value !== 0) {
                    byte |= 0x80;
                }
                result.push(byte);
            } while (value !== 0);
            return Buffer.from(result);
        }

        function encodeString(value: string) {
            const result = Buffer.from(value, 'utf8');
            return Buffer.concat([encodeLEB128(result.length), result]);
        }

        do {
            const sectionStart = offset;
            const sectionId = input.readUInt8(offset);
            offset++;
            const sectionSize = decodeLEB128();
            const sectionEnd = offset + sectionSize;

            if (sectionId == 5) {
                // Memory section
                // Make sure it's empty and only imported memory is used
                parts.push(Buffer.from([5, 1, 0]));
            } else if (sectionId == 2) {
                // Import section
                const sectionParts: Buffer[] = [];
                const numImports = decodeLEB128();
                for (let i = 0; i < numImports; i++) {
                    const importStart = offset;
                    decodeString();
                    decodeString();
                    const kind = input.readUInt8(offset);
                    offset++;

                    let skipImport = false;
                    switch (kind) {
                        case 0:
                            // Function import
                            decodeLEB128(); // index
                            break;
                        case 1:
                            // Table import
                            offset++; // type
                            decodeLimits();
                            break;
                        case 2:
                            // Memory import
                            decodeLimits();
                            // NOTE: existing memory import is removed (so no need to add it to sectionParts)
                            skipImport = true;
                            break;
                        case 3:
                            // Global import
                            offset++; // type
                            offset++; // mutability
                            break;
                        default:
                            throw new Error('Invalid import kind: ' + kind);
                    }

                    if (!skipImport) {
                        sectionParts.push(input.subarray(importStart, offset));
                    }
                }

                const importMemory = Buffer.concat([
                    encodeString('env'),
                    encodeString('memory'),
                    Buffer.from([2]), // Memory import
                    // TODO: Check what values to use
                    Buffer.from([0]),
                    encodeLEB128(1),
                ]);

                sectionParts.push(importMemory);

                const sectionData = Buffer.concat([
                    encodeLEB128(sectionParts.length),
                    ...sectionParts,
                ]);

                parts.push(Buffer.concat([
                    Buffer.from([2]), // Import section
                    encodeLEB128(sectionData.length),
                    sectionData
                ]));
            } else if (sectionId == 7) {
                // Export section
                const sectionParts: Buffer[] = [];
                const numExports = decodeLEB128();
                for (let i = 0; i < numExports; i++) {
                    const exportStart = offset;
                    decodeString();
                    const kind = input.readUInt8(offset);
                    offset++;
                    decodeLEB128();

                    if (kind !== 2) {
                        // Pass through all exports except memory
                        sectionParts.push(input.subarray(exportStart, offset));
                    }
                }

                const sectionData = Buffer.concat([
                    encodeLEB128(sectionParts.length),
                    ...sectionParts,
                ]);

                parts.push(Buffer.concat([
                    Buffer.from([7]), // Export section
                    encodeLEB128(sectionData.length),
                    sectionData
                ]));
            } else {
                parts.push(input.subarray(sectionStart, sectionEnd));
            }

            offset = sectionEnd;
        } while (offset < input.length);

        return Buffer.concat(parts);
    }

    private getHostImports() {
        return {
            register_len: (registerId: bigint) => {
                return BigInt(this.registers[registerId.toString()] ? this.registers[registerId.toString()].length : Number.MAX_SAFE_INTEGER);
            },
            read_register: (registerId: bigint, ptr: bigint) => {
                const mem = new Uint8Array(this.memory.buffer);
                mem.set(this.registers[registerId.toString()] || Buffer.from([]), Number(ptr));
            },
            write_register: prohibitedInView('write_register'),
            current_account_id: (registerId: bigint) => {
                this.registers[registerId.toString()] = Buffer.from(this.context.contractId);
            },
            signer_account_id: prohibitedInView('signer_account_id'),
            signer_account_pk: prohibitedInView('signer_account_pk'),
            predecessor_account_id: prohibitedInView('predecessor_account_id'),
            input: (registerId: bigint) => {
                this.registers[registerId.toString()] = Buffer.from(this.context.methodArgs);
            },
            block_index: () => {
                return BigInt(this.context.blockHeight);
            },
            block_timestamp: () => {
                return BigInt(this.context.blockTimestamp);
            },
            epoch_height: notImplemented('epoch_height'),
            storage_usage: notImplemented('storage_usage'),
            account_balance: notImplemented('account_balance'),
            account_locked_balance: notImplemented('account_locked_balance'),
            attached_deposit: prohibitedInView('attached_deposit'),
            prepaid_gas: prohibitedInView('prepaid_gas'),
            used_gas: prohibitedInView('used_gas'),
            random_seed: notImplemented('random_seed'),
            sha256: (valueLen: bigint, valuePtr: bigint, registerId: bigint) => {
                const value = new Uint8Array(this.memory.buffer, Number(valuePtr), Number(valueLen));
                const hash = createHash('sha256');
                hash.update(value);
                this.registers[registerId.toString()] = hash.digest();
            },
            ripemd160: notImplemented('ripemd160'),
            keccak256: notImplemented('keccak256'),
            keccak512: notImplemented('keccak512'),
            ecrecover: notImplemented('ecrecover'),
            value_return: (valueLen: bigint, valuePtr: bigint) => {
                this.result = Buffer.from(new Uint8Array(this.memory.buffer, Number(valuePtr), Number(valueLen)));
            },
            panic: () => {
                throw new Error('panic: explicit guest panic');
            },
            panic_utf8: (len: bigint, ptr: bigint) => {
                throw new Error('panic: ' + this.readUTF8CStr(len, ptr));
            },
            abort: (msg_ptr: bigint, filename_ptr: bigint, line: number, col: number) => {
                const msg = this.readUTF16CStr(msg_ptr);
                const filename = this.readUTF16CStr(filename_ptr);
                const message = `${msg} ${filename}:${line}:${col}`;
                if (!msg || !filename) {
                    // TODO: Check when exactly this gets thrown in nearcore, as it's weird choice for empty C string
                    // TODO: Check what happens with actual invalid UTF-16
                    throw new Error('abort: ' + 'String encoding is bad UTF-16 sequence.');
                }
                throw new Error('abort: ' + message);
            },
            log_utf8: (len: bigint, ptr: bigint) => {
                this.logs.push(this.readUTF8CStr(len, ptr));
            },
            log_utf16: (len: bigint, ptr: bigint) => {
                this.logs.push(this.readUTF8CStr(len, ptr));
            },
            promise_create: prohibitedInView('promise_create'),
            promise_then: prohibitedInView('promise_then'),
            promise_and: prohibitedInView('promise_and'),
            promise_batch_create: prohibitedInView('promise_batch_create'),
            promise_batch_then: prohibitedInView('promise_batch_then'),
            promise_batch_action_create_account: prohibitedInView('promise_batch_action_create_account'),
            promise_batch_action_deploy_contract: prohibitedInView('promise_batch_action_deploy_contract'),
            promise_batch_action_function_call: prohibitedInView('promise_batch_action_function_call'),
            promise_batch_action_function_call_weight: prohibitedInView('promise_batch_action_function_call_weight'),
            promise_batch_action_transfer: prohibitedInView('promise_batch_action_transfer'),
            promise_batch_action_stake: prohibitedInView('promise_batch_action_stake'),
            promise_batch_action_add_key_with_full_access: prohibitedInView('promise_batch_action_add_key_with_full_access'),
            promise_batch_action_add_key_with_function_call: prohibitedInView(
                'promise_batch_action_add_key_with_function_call'
            ),
            promise_batch_action_delete_key: prohibitedInView('promise_batch_action_delete_key'),
            promise_batch_action_delete_account: prohibitedInView('promise_batch_action_delete_account'),
            promise_results_count: prohibitedInView('promise_results_count'),
            promise_result: prohibitedInView('promise_result'),
            promise_return: prohibitedInView('promise_return'),
            storage_write: prohibitedInView('storage_write'),
            storage_read: (key_len: bigint, key_ptr: bigint, register_id: number): bigint => {
                const result = this.storageRead(key_len, key_ptr);

                if (result == null) {
                    return BigInt(0);
                }

                this.registers[register_id] = result;
                return BigInt(1);
            },
            storage_remove: prohibitedInView('storage_remove'),
            storage_has_key: (key_len: bigint, key_ptr: bigint): bigint => {
                const result = this.storageRead(key_len, key_ptr);

                if (result == null) {
                    return BigInt(0);
                }

                return BigInt(1);
            },
            validator_stake: notImplemented('validator_stake'),
            validator_total_stake: notImplemented('validator_total_stake'),
        };
    }

    async execute(methodName: string) {
        const module = await WebAssembly.compile(this.wasm);
        const instance = await WebAssembly.instantiate(module, { env: { ...this.getHostImports(), memory: this.memory } });

        const callMethod = instance.exports[methodName] as CallableFunction | undefined;

        if (callMethod == undefined) {
            throw new Error(`Contract method '${methodName}' does not exists in contract ${this.context.contractId} for block id ${this.context.blockHeight}`);
        }

        callMethod();

        return {
            result: this.result,
            logs: this.logs
        };
    }
}
