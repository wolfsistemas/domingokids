// js/modal-lock.js
// Trava o scroll da pagina de fundo enquanto qualquer modal estiver aberto.
// Evita que, ao arrastar dentro do modal, o conteudo atras se mova (scroll chaining).
// Detecta modais por classe (.modal / .modal-overlay) e observa mudancas de
// style/class, entao funciona com qualquer mecanismo de abrir/fechar.
(function () {
    'use strict';

    var SELECTOR = '.modal, .modal-overlay';
    var LOCK_CLASS = 'dk-modal-lock';
    var bloqueado = false;
    var scrollY = 0;
    var agendado = false;

    function visivel(el) {
        var st = window.getComputedStyle(el);
        if (st.display === 'none') return false;
        if (st.visibility === 'hidden') return false;
        if (parseFloat(st.opacity || '1') === 0) return false;
        return true;
    }

    function contarAbertos() {
        var els = document.querySelectorAll(SELECTOR);
        var n = 0;
        for (var i = 0; i < els.length; i++) {
            if (visivel(els[i])) n++;
        }
        return n;
    }

    function travar() {
        if (bloqueado || !document.body) return;
        scrollY = window.scrollY || document.documentElement.scrollTop || 0;
        document.body.style.top = '-' + scrollY + 'px';
        document.body.classList.add(LOCK_CLASS);
        bloqueado = true;
    }

    function destravar() {
        if (!bloqueado) return;
        document.body.classList.remove(LOCK_CLASS);
        document.body.style.top = '';
        bloqueado = false;
        window.scrollTo(0, scrollY);
    }

    function atualizar() {
        agendado = false;
        if (contarAbertos() > 0) travar();
        else destravar();
    }

    function agendar() {
        if (agendado) return;
        agendado = true;
        if (window.requestAnimationFrame) window.requestAnimationFrame(atualizar);
        else setTimeout(atualizar, 50);
    }

    function injetarEstilo() {
        var style = document.createElement('style');
        style.textContent =
            '.modal, .modal-overlay, .modal-content, .modal-box { overscroll-behavior: contain; }' +
            'body.' + LOCK_CLASS + ' { position: fixed; left: 0; right: 0; width: 100%; overflow: hidden; }';
        document.head.appendChild(style);
    }

    function iniciar() {
        if (!document.body) return;
        injetarEstilo();
        try {
            var mo = new MutationObserver(agendar);
            mo.observe(document.documentElement, {
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });
        } catch (e) {
            setInterval(agendar, 400);
        }
        agendar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
