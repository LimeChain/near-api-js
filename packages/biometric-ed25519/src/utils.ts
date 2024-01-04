import base64 from '@hexagon/base64';
import { secp256k1 } from '@noble/curves/secp256k1';
import { Sha256 } from '@aws-crypto/sha256-js';
import { PublicKey } from '@near-js/crypto';

export const preformatMakeCredReq = (makeCredReq) => {
    const challenge = base64.toArrayBuffer(makeCredReq.challenge, true);
    const userId = base64.toArrayBuffer(makeCredReq.user.id, true);

    return {
        ...makeCredReq,
        challenge,
        user: {
            ...makeCredReq.user,
            id: userId,
        },
        ...(makeCredReq.excludeCredentials ? {
            excludeCredentials: makeCredReq.excludeCredentials.map((e) => {
                return { id: base64.toArrayBuffer(e.id, true), type: e.type };
            })
        } : {})
    };
};

export const get64BytePublicKeyFromPEM = (publicKey: PublicKey) => {
    const prefix = '\n';
    const publicKeyBase64 = publicKey.toString().split(prefix);
    return base64.toArrayBuffer(`${publicKeyBase64[1]}${publicKeyBase64[2]}`).slice(27);
};

export const validateUsername = (name: string): string => {
    if (!name) {
        throw new Error('username is required');
    }
    return name;
};

export const preformatGetAssertReq = (getAssert) => {
    getAssert.challenge = base64.toArrayBuffer(getAssert.challenge, true);

    // Allow any credential, this will be handled later
    for (const allowCred of getAssert.allowCredentials) {
        allowCred.id = base64.toArrayBuffer(allowCred.id, true);
    }

    return getAssert;
};


export const publicKeyCredentialToJSON = (pubKeyCred) => {
    if (pubKeyCred instanceof Array) {
        const arr = [];
        for (const i of pubKeyCred)
            arr.push(publicKeyCredentialToJSON(i));

        return arr;
    }

    if (pubKeyCred instanceof ArrayBuffer) {
        return base64.fromArrayBuffer(pubKeyCred, true);
    }

    if (pubKeyCred instanceof Object) {
        const obj = {};

        for (const key in pubKeyCred) {
            obj[key] = publicKeyCredentialToJSON(pubKeyCred[key]);
        }

        return obj;
    }

    return pubKeyCred;
};

export const recoverPublicKey = async (r, s, message, recovery) => {
    if (recovery !== 0 && recovery !== 1) {
        throw new Error('Invalid recovery parameter');
    }
    
    const hash = new Sha256();
    hash.update(message);

    const sigObjQ = new secp256k1.Signature(r, s);
    sigObjQ.addRecoveryBit(0);
    const sigObjP = new secp256k1.Signature(r, s);
    sigObjP.addRecoveryBit(1);

    const h = await hash.digest();

    const Q = sigObjQ.recoverPublicKey(h);
    const P = sigObjP.recoverPublicKey(h);

    return [
        Buffer.from(Q.toRawBytes()).subarray(1, 65),
        Buffer.from(P.toRawBytes()).subarray(1, 65)
    ];
};
