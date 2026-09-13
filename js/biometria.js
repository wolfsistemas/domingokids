const Biometria = (function () {
    const STORAGE_KEY = 'dk_webauthn';
    const RP_NAME = 'Kids Checkin';

    function bufferToBase64url(buffer) {
        const bytes = new Uint8Array(buffer);
        let str = '';
        for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function base64urlToBuffer(base64url) {
        const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
        const base64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return bytes.buffer;
    }

    function desafioAleatorio() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return bytes.buffer;
    }

    function textoParaBuffer(texto) {
        return new TextEncoder().encode(texto).buffer;
    }

    function rpId() {
        return window.location.hostname;
    }

    function ambienteOk() {
        const https = window.isSecureContext;
        const api = !!(window.PublicKeyCredential && navigator.credentials);
        return https && api;
    }

    async function plataformaDisponivel() {
        if (!ambienteOk()) return false;
        try {
            return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        } catch (e) {
            return false;
        }
    }

    function lerCadastro() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function salvarCadastro(dados) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dados));
    }

    function temCadastro() {
        const c = lerCadastro();
        return !!(c && c.credentialId && c.email);
    }

    function cadastradaPara(email) {
        const c = lerCadastro();
        return !!(c && c.email && email && c.email.toLowerCase() === email.toLowerCase());
    }

    function removerCadastro() {
        localStorage.removeItem(STORAGE_KEY);
    }

    async function registrar({ userId, email, nome }) {
        if (!(await plataformaDisponivel())) {
            throw new Error('Este aparelho não oferece digital ou Face ID no navegador.');
        }

        const credencial = await navigator.credentials.create({
            publicKey: {
                challenge: desafioAleatorio(),
                rp: { name: RP_NAME, id: rpId() },
                user: {
                    id: textoParaBuffer(String(userId || email)),
                    name: email,
                    displayName: nome || email
                },
                pubKeyCredParams: [
                    { type: 'public-key', alg: -7 },
                    { type: 'public-key', alg: -257 }
                ],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    userVerification: 'required',
                    residentKey: 'preferred'
                },
                timeout: 60000,
                attestation: 'none'
            }
        });

        if (!credencial) throw new Error('Registro biométrico cancelado.');

        salvarCadastro({
            credentialId: bufferToBase64url(credencial.rawId),
            email: email,
            nome: nome || '',
            userId: userId || '',
            criadoEm: new Date().toISOString()
        });

        return lerCadastro();
    }

    async function autenticar() {
        const cadastro = lerCadastro();
        if (!cadastro) throw new Error('Nenhuma digital/Face ID cadastrada neste aparelho.');

        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge: desafioAleatorio(),
                rpId: rpId(),
                allowCredentials: [{
                    type: 'public-key',
                    id: base64urlToBuffer(cadastro.credentialId),
                    transports: ['internal']
                }],
                userVerification: 'required',
                timeout: 60000
            }
        });

        if (!assertion) throw new Error('Autenticação biométrica cancelada.');
        return cadastro;
    }

        

    return {
        ambienteOk,
        plataformaDisponivel,
        temCadastro,
        cadastradaPara,
        lerCadastro,
        registrar,
        autenticar,
        removerCadastro
    };
})();       
