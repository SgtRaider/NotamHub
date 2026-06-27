// pdfExport.js — Genera un PDF con los NOTAMs/TSAs seleccionados.
//
// Contenido del PDF:
//   1) Portada: título + fecha de generación + filtros aplicados (FIR y
//      Tipos seleccionados) + recuento.
//   2) Imagen del mapa SATÉLITE (mapView.captureForPdf) con una etiqueta
//      (TAG) encima de cada NOTAM mostrado con su nombre
//      (p.ej. "D3181/26 · ESPADANEDO").
//   3) Listado: por cada NOTAM seleccionado, su DECODE (categoría, país/FIR,
//      Q-code y significado, ámbito, tráfico, propósito, altitud, vigencia)
//      y el TEXTO crudo del NOTAM.
//
// Usa jsPDF (UMD, window.jspdf.jsPDF). Sin dependencias adicionales.
window.NotamHub = window.NotamHub || {};
window.NotamHub.pdfExport = (function () {
  'use strict';

  const PAGE = { w: 210, h: 297 };      // A4 mm
  const M = 14;                          // margen mm
  const CW = PAGE.w - M * 2;             // ancho de contenido
  const BOTTOM = PAGE.h - M;             // límite inferior

  const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function nh() { return window.NotamHub.notamHub; }
  function nd() { return window.NotamHub.notamDecode; }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDateTime(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '—';
    return pad2(d.getUTCDate()) + ' ' + MONTHS_ES[d.getUTCMonth()] + ' ' + d.getUTCFullYear() +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + 'Z';
  }
  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [120, 120, 120];
  }
  function catMeta(t) {
    const c = nh();
    return (c && c.getForeignCategoryMeta) ? c.getForeignCategoryMeta(t.category) : null;
  }
  function realValidity(t) {
    if (t._isPermanent) return 'Permanente';
    return fmtDateTime(t.validFrom) + ' → ' + fmtDateTime(t.validTo);
  }

  function newDoc() {
    const J = window.jspdf && window.jspdf.jsPDF;
    if (!J) return null;
    return new J({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  }

  // Construye los pares clave/valor del DECODE de un NOTAM.
  function decodeRows(t) {
    const d = nd();
    const rows = [];
    const meta = catMeta(t);
    if (meta) rows.push(['Categoría', meta.label]);
    const cf = [t.country, t.fir].filter(Boolean).join(' / ');
    if (cf) rows.push(['País / FIR', cf]);
    if (t.qCode) {
      const q = d ? d.decodeQ(t.qCode) : null;
      rows.push(['Q-code', t.qCode + (q && q.text ? ' — ' + q.text : '')]);
    }
    if (t.scope)   rows.push(['Ámbito', t.scope + (d ? ' — ' + d.decodeScope(t.scope) : '')]);
    if (t.traffic) rows.push(['Tráfico', t.traffic + (d ? ' — ' + d.decodeTraffic(t.traffic) : '')]);
    if (t.purpose) rows.push(['Propósito', t.purpose + (d ? ' — ' + d.decodePurpose(t.purpose) : '')]);
    if (!t._foreign) rows.push(['Tipo', 'NOTAM nacional']);
    if (t.airport)  rows.push(['Aeropuerto', t.airport]);
    const alt = ((t.vertical && t.vertical.lowerLabel) || 'GND') + ' → ' + ((t.vertical && t.vertical.upperLabel) || 'UNL');
    rows.push(['Altitud', alt]);
    if (t._isCircle && t._circleRadiusNm != null) rows.push(['Círculo', Math.round(t._circleRadiusNm) + ' NM de radio']);
    rows.push(['Vigencia', realValidity(t)]);
    if (t._firWide) rows.push(['Cobertura', 'Todo el FIR (sin área concreta)']);
    return rows;
  }

  // Genera y descarga el PDF.
  //   opts.items     : NOTAMs/TSAs a incluir (ya filtrados/seleccionados)
  //   opts.firLabel  : texto del filtro FIR (p.ej. "Todos" o "LECM, DAAA")
  //   opts.catLabel  : texto del filtro de tipos
  //   opts.onProgress: callback(string) opcional para feedback de UI
  async function generate(opts) {
    opts = opts || {};
    const items = (opts.items || []).slice();
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    if (!items.length) { alert('No hay NOTAMs seleccionados para exportar.'); return false; }
    const doc = newDoc();
    if (!doc) { alert('No se pudo cargar la librería PDF (jsPDF). Revisa la conexión.'); return false; }

    // 1) Captura del mapa.
    progress('Generando imagen del mapa…');
    let mapImg = null;
    try {
      const mv = window.NotamHub.mapView;
      if (mv && mv.captureForPdf) mapImg = await mv.captureForPdf(items, {});
    } catch (e) { console.warn('[pdf] captura de mapa falló:', e); }

    progress('Componiendo PDF…');
    const now = new Date();
    let y = M;

    // ── Cabecera ──────────────────────────────────────────────────────
    doc.setFillColor(15, 118, 110);             // teal NotamHub
    doc.rect(0, 0, PAGE.w, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('NotamHub — Informe NOTAM / TSA', M, 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text('Generado ' + fmtDateTime(now), PAGE.w - M, 14, { align: 'right' });
    y = 28;

    doc.setTextColor(30, 41, 59);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    const filtFir = 'FIR: ' + (opts.firLabel || 'Todos');
    const filtCat = 'Tipos: ' + (opts.catLabel || 'Todos');
    doc.text(filtFir + '     ·     ' + filtCat + '     ·     ' + items.length + ' NOTAM', M, y);
    y += 6;
    doc.setDrawColor(203, 213, 225); doc.line(M, y, PAGE.w - M, y);
    y += 5;

    // ── Imagen del mapa ───────────────────────────────────────────────
    if (mapImg && mapImg.dataUrl) {
      const imgW = CW;
      const imgH = Math.min(imgW * mapImg.height / mapImg.width, 165);
      if (y + imgH > BOTTOM) { doc.addPage(); y = M; }
      try { doc.addImage(mapImg.dataUrl, 'JPEG', M, y, imgW, imgH); } catch (e) { console.warn('[pdf] addImage:', e); }
      doc.setDrawColor(148, 163, 184); doc.rect(M, y, imgW, imgH);
      y += imgH + 2;
      doc.setFontSize(8); doc.setTextColor(100, 116, 139);
      doc.text('Mapa satélite (Esri) · etiquetas = nombre del NOTAM', M, y + 2);
      y += 7;
    } else {
      doc.setFontSize(9); doc.setTextColor(180, 60, 60);
      doc.text('No se pudo generar la imagen del mapa.', M, y + 2);
      y += 8;
    }

    // ── Listado de NOTAMs ─────────────────────────────────────────────
    doc.setTextColor(30, 41, 59);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    if (y + 10 > BOTTOM) { doc.addPage(); y = M; }
    doc.text('Detalle de NOTAMs (' + items.length + ')', M, y);
    y += 6;

    const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };

    items.forEach((t, idx) => {
      // Estima la altura del bloque (cabecera + decode + cuerpo) para evitar
      // que el nombre quede huérfano al final de página.
      ensure(16);
      const color = hexToRgb((catMeta(t) && catMeta(t).color) || '#0f766e');

      // Nombre + cuadrado de color.
      doc.setFillColor(color[0], color[1], color[2]);
      doc.rect(M, y - 3.2, 3, 3, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(15, 23, 42);
      const nameLines = doc.splitTextToSize(String(t.name || t.id || '—'), CW - 6);
      doc.text(nameLines, M + 5, y);
      y += nameLines.length * 5 + 1;

      // Decode (clave: valor).
      doc.setFontSize(8.5);
      const rows = decodeRows(t);
      rows.forEach(([k, v]) => {
        const vLines = doc.splitTextToSize(String(v), CW - 34);
        ensure(vLines.length * 4 + 1);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(71, 85, 105);
        doc.text(k, M + 5, y);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 41, 59);
        doc.text(vLines, M + 33, y);
        y += vLines.length * 4 + 0.5;
      });

      // Texto crudo del NOTAM.
      if (t.remarks) {
        y += 1;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(71, 85, 105);
        ensure(5);
        doc.text('Texto NOTAM', M + 5, y); y += 3.5;
        doc.setFont('courier', 'normal'); doc.setFontSize(8); doc.setTextColor(15, 23, 42);
        const bodyLines = doc.splitTextToSize(String(t.remarks).trim(), CW - 8);
        bodyLines.forEach((ln) => {
          ensure(3.6);
          doc.text(ln, M + 5, y);
          y += 3.6;
        });
      }

      // Separador entre NOTAMs.
      y += 2.5;
      if (idx < items.length - 1) {
        ensure(3);
        doc.setDrawColor(226, 232, 240); doc.line(M, y, PAGE.w - M, y);
        y += 3.5;
      }
    });

    // ── Pie de página con numeración ──────────────────────────────────
    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
      doc.text('NotamHub · ' + fmtDateTime(now), M, PAGE.h - 6);
      doc.text(p + ' / ' + total, PAGE.w - M, PAGE.h - 6, { align: 'right' });
    }

    const stamp = now.getUTCFullYear() + pad2(now.getUTCMonth() + 1) + pad2(now.getUTCDate()) +
      '_' + pad2(now.getUTCHours()) + pad2(now.getUTCMinutes());
    progress('');
    doc.save('NotamHub_' + stamp + '.pdf');
    return true;
  }

  return { generate };
})();
