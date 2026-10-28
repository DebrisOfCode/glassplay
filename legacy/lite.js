// GlassPlay legacy: attiva la versione alleggerita (in app.js, "lite") e aggiunge alle WebView
// più vecchie le poche funzioni recenti usate dall'app. Android 9 di serie ha Chromium 66 o
// successivo; il resto del codice viene convertito per quella versione durante la compilazione.
window.GLASSPLAY_LITE = true;

(function () {
  'use strict';

  // Chromium 86
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      this.append.apply(this, arguments);
    };
  }

  // Chromium 84: "gap" nei flexbox. Senza, lite.css usa margini (classe no-flex-gap).
  var probe = document.createElement('div');
  probe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute';
  probe.appendChild(document.createElement('div'));
  probe.appendChild(document.createElement('div'));
  document.documentElement.appendChild(probe);
  if (probe.scrollHeight !== 1) document.documentElement.classList.add('no-flex-gap');
  document.documentElement.removeChild(probe);

  // Chromium 76: invia il modulo come il pulsante "OK", controllando prima i campi obbligatori.
  if (!HTMLFormElement.prototype.requestSubmit) {
    HTMLFormElement.prototype.requestSubmit = function () {
      if (!this.reportValidity()) return;
      var ev = document.createEvent('Event');
      ev.initEvent('submit', true, true);
      this.dispatchEvent(ev);
    };
  }
})();
