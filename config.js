// config.js - Configuração central do Supabase
const SUPABASE_URL = 'https://asriklhdbzxubdcuauoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzcmlrbGhkYnp4dWJkY3VhdW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTkzNzcsImV4cCI6MjEwMDgzNTM3N30.vhOVWm--45F7CTthWG4pZJdqo4DDcG6vMnua1hYSUuM';

// Para compatibilidade com os nomes usados nos HTMLs
const SB_URL = SUPABASE_URL;
const SB_KEY = SUPABASE_ANON_KEY;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';
const VAPID_PUBLIC_KEY = 'BJ4YbI1bdeeM_GzNCpS-nq1lA1eeGEdahIn09pmL4qchZ92AIsURlLzoj6cPr57IruFBoZ8mD-6dSrtsKeU5NFQ';

// Instância global do cliente Supabase (será usada em todos os lugares)
//const supabaseClient = supabase.createClient(SB_URL, SB_KEY);

// Upload de imagens: usa a Edge Function `imgbb-upload` (chave mantida no servidor).

// Remove a sessão salva no navegador SEM revogar no servidor.
// Usado no logout de aparelhos com biometria, para que o refresh token
// guardado no backup continue válido para o login rápido.
function limparSessaoLocalSupabase() {
    try {
        const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
        const prefixo = 'sb-' + ref + '-auth-token';
        const chaves = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf(prefixo) === 0) chaves.push(k);
        }
        chaves.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
}

// Encerra a sessão e volta para a tela de login.
// Se houver biometria cadastrada, guarda um backup dos tokens e faz um logout
// apenas local (sem revogar no servidor), para o login rápido por biometria
// continuar funcionando no próximo acesso.
async function encerrarSessao(destino) {
    const alvo = destino || 'index.html';
    try {
        const temBio = !!localStorage.getItem('dk_webauthn');
        if (typeof supabaseClient !== 'undefined' && supabaseClient) {
            if (temBio) {
                const { data } = await supabaseClient.auth.getSession();
                if (data && data.session) {
                    localStorage.setItem('dk_sessao_bio', JSON.stringify({
                        access_token: data.session.access_token,
                        refresh_token: data.session.refresh_token,
                        email: (data.session.user && data.session.user.email) || '',
                        salvoEm: new Date().toISOString()
                    }));
                }
                try { await supabaseClient.auth.stopAutoRefresh(); } catch (e) {}
                limparSessaoLocalSupabase();
            } else {
                await supabaseClient.auth.signOut();
            }
        }
    } catch (e) {}
    window.location.href = alvo + '?t=' + Date.now() + '&logout=1';
}

