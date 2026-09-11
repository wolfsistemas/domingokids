(function () {
  const DISMISS_KEY = 'dk_pwa_install_dismissed';
  let deferredPrompt = null;

  function injetarEstilos() {
    if (document.getElementById('videira-pwa-style')) return;
    const style = document.createElement('style');
    style.id = 'videira-pwa-style';
    style.textContent = [
      '#videira-pwa-install{position:fixed !important;left:12px;right:12px;bottom:16px;z-index:99999;',
      'display:none;align-items:center;gap:12px;background:#8b5a6a;color:#fff;',
      'padding:12px 14px;border-radius:14px;box-shadow:0 10px 30px rgba(74,59,62,.28);',
      'font-family:Inter,system-ui,sans-serif;box-sizing:border-box;transform:translateZ(0);',
      '-webkit-transform:translateZ(0);pointer-events:auto;}',
      '#videira-pwa-install *{box-sizing:border-box;}',
      '#videira-pwa-install img{width:40px;height:40px;border-radius:10px;flex:0 0 auto;margin:0;display:block;background:#fff;object-fit:cover;}',
      '#videira-pwa-install p{margin:0;font-size:13px;line-height:1.3;flex:1 1 auto;min-width:0;color:#fff;text-align:left;}',
      '#videira-pwa-install strong{display:block;font-size:14px;font-weight:700;color:#fff;}',
      '#videira-pwa-install .pwa-passos{display:block;margin-top:4px;color:#f3e3e8;font-size:12px;}',
      '#videira-pwa-install button{width:auto;flex:0 0 auto;margin:0;border:0;border-radius:10px;',
      'padding:8px 12px;font-size:14px;font-weight:700;line-height:1.2;cursor:pointer;',
      'box-sizing:border-box;text-align:center;appearance:none;-webkit-appearance:none;transition:none;}',
      '#videira-pwa-install button:hover{transform:none;}',
      '#videira-pwa-install .pwa-ok{background:#d4a373;color:#3a2a20;}',
      '#videira-pwa-install .pwa-ok:hover{background:#c89565;color:#3a2a20;}',
      '#videira-pwa-install .pwa-no{background:transparent;color:#f3e3e8;padding:8px;}',
      '#videira-pwa-install .pwa-no:hover{background:transparent;color:#fff;}',
      '#videira-pwa-install .pwa-share{display:inline-block;width:15px;height:15px;vertical-align:-2px;',
      'margin-right:3px;fill:#d4a373;}'
    ].join('');
    document.head.appendChild(style);
  }

  function jaInstalado() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  function isIOS() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  function forcarIOS() {
    try {
      return new URLSearchParams(window.location.search).get('pwa') === 'ios';
    } catch (e) {
      return false;
    }
  }

  function iconeUrl() {
    try {
      return new URL('icons/icon-192.png', window.location.href).href;
    } catch (e) {
      return 'icons/icon-192.png';
    }
  }

  function registrarSW() {
    if (!('serviceWorker' in navigator)) return;
    const swUrl = new URL('sw.js', window.location.href);
    navigator.serviceWorker.register(swUrl.href, { scope: './' }).catch(function () {});
  }

  function obterBox(conteudo) {
    let box = document.getElementById('videira-pwa-install');
    if (!box) {
      box = document.createElement('div');
      box.id = 'videira-pwa-install';
      (document.body || document.documentElement).appendChild(box);
    }
    box.innerHTML = conteudo;
    return box;
  }

  function ativarFechar(box) {
    const btnNo = box.querySelector('.pwa-no');
    if (!btnNo) return;
    btnNo.onclick = function () {
      sessionStorage.setItem(DISMISS_KEY, '1');
      box.style.display = 'none';
    };
  }

  const ICONE_COMPARTILHAR =
    '<svg class="pwa-share" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 2l4 4h-3v7h-2V6H8l4-4zM5 10h3v2H7v9h10v-9h-1v-2h3v13H5V10z"/></svg>';

  function mostrarBannerIOS() {
    injetarEstilos();
    const box = obterBox([
      '<img src="' + iconeUrl() + '" alt="Domingo Kids">',
      '<p><strong>Instalar o app</strong>',
      'Toque em ' + ICONE_COMPARTILHAR + 'Compartilhar e depois em ',
      '<span class="pwa-passos">"Adicionar à Tela de Início".</span></p>',
      '<button type="button" class="pwa-no" aria-label="Fechar">x</button>'
    ].join(''));
    box.style.display = 'flex';
    ativarFechar(box);
  }

  function mostrarBannerPadrao() {
    injetarEstilos();
    const temPrompt = !!deferredPrompt;
    const box = obterBox([
      '<img src="' + iconeUrl() + '" alt="Domingo Kids">',
      temPrompt
        ? '<p><strong>Instalar o app</strong>Acesso rápido na tela inicial</p>'
        : '<p><strong>Instalar o app</strong><span class="pwa-passos">No menu do navegador, toque em "Instalar app" ou "Adicionar à tela inicial".</span></p>',
      temPrompt ? '<button type="button" class="pwa-ok">Instalar</button>' : '',
      '<button type="button" class="pwa-no" aria-label="Fechar">x</button>'
    ].join(''));
    box.style.display = 'flex';

    const btnOk = box.querySelector('.pwa-ok');
    if (btnOk) {
      btnOk.onclick = function () {
        if (!deferredPrompt) return;
        box.style.display = 'none';
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () {
          deferredPrompt = null;
        });
      };
    }
    ativarFechar(box);
  }

  function mostrarCard() {
    if (!document.body) return;
    if (jaInstalado()) return;
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return;
    if (isIOS() || forcarIOS()) {
      mostrarBannerIOS();
      return;
    }
    mostrarBannerPadrao();
  }

  registrarSW();

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    mostrarCard();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    const box = document.getElementById('videira-pwa-install');
    if (box) box.style.display = 'none';
  });

  function iniciar() {
    mostrarCard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
