/**
 * Exibe um toast flutuante no canto superior direito.
 * @param {string} mensagem - Texto a ser exibido.
 * @param {string} [tipo=''] - Classe extra: 'success', 'error' ou 'info'.
 * @param {number} [duracao=3000] - Tempo em ms até sumir.
 */
function showToast(mensagem, tipo = '', duracao = 3000) {
    // Cria o container se não existir
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    // Cria o elemento do toast
    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    toast.textContent = mensagem;

    // Adiciona ao container
    container.appendChild(toast);

    // Remove após a duração + tempo da animação de saída
    setTimeout(() => {
        if (toast.parentNode) {
            toast.remove();
        }
    }, duracao + 400); // 400ms = duração do fadeOut
}
