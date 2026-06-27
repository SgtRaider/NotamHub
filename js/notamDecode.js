// notamDecode.js — Decodificador de la línea Q de los NOTAM (formato ICAO,
// Doc 8126 / Anexo 15). Traduce a español:
//   • Q-code (Q + asunto[2] + condición[2])
//   • Traffic (I/V), Purpose (N/B/O/M/K), Scope (A/E/W/K)
//
// API: window.NotamHub.notamDecode = {
//   decodeQ(qcode) -> { code, subject, condition, text }
//   decodeTraffic(s) / decodePurpose(s) / decodeScope(s) -> string
// }
window.NotamHub = window.NotamHub || {};
window.NotamHub.notamDecode = (function () {
  'use strict';

  // Asunto = 2.ª y 3.ª letra del Q-code.
  const SUBJECT = {
    // A — Organización del espacio aéreo / ATM
    AA: 'Altitud mínima', AC: 'Zona de control (CTA/CTR)', AD: 'Zona de defensa aérea (ADIZ)',
    AE: 'Área de control', AF: 'Región de información de vuelo (FIR)', AH: 'Área de control superior',
    AL: 'Nivel de vuelo mínimo utilizable', AN: 'Ruta de navegación de área', AO: 'Área de control oceánico',
    AP: 'Punto de notificación', AR: 'Ruta ATS', AT: 'Área terminal (TMA)', AU: 'FIR superior',
    AV: 'Área de asesoramiento superior', AX: 'Intersección', AZ: 'Zona de tránsito de aeródromo (ATZ)',
    // C — Comunicaciones y vigilancia
    CA: 'Estación aire-tierra', CB: 'ADS-B', CC: 'ADS-C', CD: 'CPDLC', CE: 'Radar de ruta',
    CG: 'Aproximación controlada desde tierra (GCA)', CL: 'SELCAL', CM: 'Radar de movimiento de superficie',
    CP: 'Radar de aproximación de precisión (PAR)', CR: 'Radar de vigilancia de ruta', CS: 'Radar secundario (SSR)',
    CT: 'Sistema de vigilancia dependiente',
    // F — Instalaciones y servicios
    FA: 'Aeródromo', FB: 'Acción de frenado', FC: 'Techo de nubes', FF: 'Servicio contraincendios/rescate',
    FM: 'Servicio meteorológico', FO: 'Dispersión de niebla', FP: 'Helipuerto', FS: 'Retirada de nieve',
    FT: 'Transmisómetro', FU: 'Combustible', FW: 'Indicador de dirección del viento', FZ: 'Aduana/inmigración',
    // G — GNSS
    GA: 'Servicio GNSS (específico de aeródromo)', GW: 'Servicio GNSS (área extensa)',
    // I — ILS / MLS
    IC: 'ILS', ID: 'DME asociado al ILS', IG: 'Senda de planeo (glide path)', II: 'Radiobaliza interior',
    IL: 'Localizador', IM: 'Radiobaliza intermedia', IN: 'Localizador (sin ILS)', IO: 'Radiobaliza exterior',
    IS: 'ILS Categoría I', IT: 'ILS Categoría II', IU: 'ILS Categoría III', IW: 'MLS',
    IX: 'Localizador exterior (LOM)', IY: 'Localizador intermedio (LMM)',
    // L — Iluminación
    LA: 'Luces de aproximación', LB: 'Faro de aeródromo', LC: 'Luces de eje de pista', LD: 'Indicador de dirección de aterrizaje',
    LE: 'Luces de borde de pista', LF: 'Luces de destello secuencial', LG: 'Iluminación controlada por el piloto',
    LH: 'Luces de aproximación de alta intensidad', LI: 'Luces identificadoras de cabecera', LJ: 'Luces de alineación de pista',
    LK: 'Luces CAT II/III', LL: 'Luces de aproximación de baja intensidad', LM: 'Luces de zona de toma de contacto',
    LP: 'PAPI', LR: 'Sistema de luces del área de aterrizaje', LS: 'Luces de zona de parada (stopway)',
    LT: 'Luces de umbral', LU: 'Indicador de trayectoria de aproximación (helicópteros)', LV: 'VASIS',
    LW: 'Luces de helipuerto', LX: 'Luces de eje de calle de rodaje', LY: 'Luces de borde de calle de rodaje',
    LZ: 'Luces de zona de toma de contacto',
    // M — Área de movimiento y aterrizaje
    MA: 'Área de movimiento', MB: 'Resistencia del pavimento', MC: 'Zona libre de obstáculos (clearway)',
    MD: 'Distancias declaradas', MG: 'Sistema de guía de rodaje', MH: 'Margen de pista (shoulder)',
    MK: 'Zona de estacionamiento', MM: 'Señalización diurna', MN: 'Plataforma (apron)', MO: 'Barra de parada',
    MP: 'Puestos de estacionamiento de aeronaves', MR: 'Pista (RWY)', MS: 'Zona de parada (stopway)',
    MT: 'Umbral', MU: 'Zona de viraje de pista', MW: 'Franja/margen', MX: 'Calle de rodaje (TWY)',
    MY: 'Calle de salida rápida',
    // N — Radioayudas
    NA: 'Todas las radioayudas', NB: 'Radiobaliza no direccional (NDB)', NC: 'DECCA', ND: 'DME',
    NF: 'Radiobaliza en abanico', NL: 'Localizador (LOM/LMM)', NM: 'VOR/DME', NN: 'TACAN', NO: 'OMEGA',
    NT: 'VORTAC', NV: 'VOR', NX: 'Estación de radiogoniometría (DF)',
    // O — Otros
    OA: 'Servicio de información aeronáutica (AIS)', OB: 'Obstáculo', OE: 'Requisitos de entrada de aeronaves',
    OL: 'Luces de obstáculo', OR: 'Centro coordinador de salvamento (RCC)',
    // P — Procedimientos ATM
    PA: 'Llegada normalizada por instrumentos (STAR)', PB: 'Llegada VFR normalizada', PC: 'Procedimiento de contingencia',
    PD: 'Salida normalizada por instrumentos (SID)', PE: 'Salida VFR normalizada', PF: 'Control de afluencia (ATFM)',
    PH: 'Procedimiento de espera (holding)', PI: 'Procedimiento de aproximación por instrumentos', PK: 'Aproximación VFR',
    PL: 'Procesamiento del plan de vuelo', PM: 'Mínimos de operación del aeródromo', PN: 'Procedimiento antirruido',
    PO: 'Altitud/altura de franqueamiento de obstáculos', PP: 'Requisitos PBN', PR: 'Procedimiento de fallo de radio',
    PT: 'Altitud/nivel de transición', PU: 'Procedimiento de aproximación frustrada', PX: 'Altitud mínima de espera',
    PZ: 'Procedimientos de la ADIZ',
    // R — Restricciones de espacio aéreo
    RA: 'Zona/área reservada', RD: 'Zona peligrosa (D)', RM: 'Zona militar (MOA/restringida militar)',
    RO: 'Sobrevuelo', RP: 'Zona prohibida (P)', RR: 'Zona restringida (R)', RT: 'Zona restringida temporal (TRA/TSA)',
    // S — Servicios de tránsito aéreo
    SA: 'Servicio automático de información de área terminal (ATIS)', SB: 'Oficina de notificación ATS (ARO)',
    SC: 'Centro de control de área (ACC)', SE: 'Servicio de información de vuelo (FIS)',
    SF: 'Servicio de información de vuelo de aeródromo (AFIS)', SL: 'Centro de control de afluencia',
    SO: 'Control oceánico', SP: 'Control de aproximación (APP)', SS: 'Estación de servicio de vuelo (FSS)',
    ST: 'Torre de control de aeródromo (TWR)', SU: 'Control de área superior', SV: 'VOLMET',
    SY: 'Servicio de asesoramiento superior',
    // W — Avisos de navegación / actividades
    WA: 'Exhibición aérea', WB: 'Acrobacia aérea', WC: 'Globo cautivo/cometa', WD: 'Demolición de explosivos',
    WE: 'Ejercicios (militares)', WF: 'Reabastecimiento en vuelo', WG: 'Vuelo de planeadores', WH: 'Voladuras',
    WJ: 'Remolque de banderolas/blancos', WL: 'Ascenso de globo libre', WM: 'Disparo de misiles/cañón/cohetes',
    WP: 'Lanzamiento de paracaidistas', WR: 'Material radiactivo/tóxico', WS: 'Quema/venteo de gas',
    WT: 'Movimiento masivo de aeronaves', WU: 'Aeronaves no tripuladas (UAS/RPAS)', WV: 'Vuelo en formación',
    WW: 'Actividad volcánica significativa', WZ: 'Aeromodelismo',
  };

  // Condición = 4.ª y 5.ª letra del Q-code.
  const CONDITION = {
    // Disponibilidad (A)
    AC: 'Retirada por mantenimiento', AD: 'Disponible para operación diurna', AF: 'Verificada en vuelo y fiable',
    AG: 'En servicio, solo verificada en tierra', AH: 'Horario de servicio ahora…', AK: 'Reanuda operación normal',
    AL: 'Operativa con las limitaciones ya publicadas', AM: 'Solo operaciones militares', AN: 'Disponible para operación nocturna',
    AO: 'Operacional', AP: 'Disponible, requiere permiso previo (PPR)', AR: 'Disponible a petición',
    AS: 'Fuera de servicio (U/S)', AU: 'No disponible', AW: 'Retirada completamente',
    AX: 'Cancelado el cierre publicado previamente',
    // Cambios (C)
    CA: 'Activado', CC: 'Completado', CD: 'Desactivado', CE: 'Erigido/instalado', CF: 'Frecuencia cambiada a…',
    CG: 'Degradado a…', CH: 'Modificado', CI: 'Identificación/indicativo cambiado a…', CL: 'Realineado',
    CM: 'Desplazado', CN: 'Cancelado', CO: 'Operando', CP: 'Mejorado a…', CR: 'Sustituido temporalmente por…',
    CS: 'Instalado', CT: 'En pruebas, no utilizar',
    // Peligro / estado de la superficie (H)
    HA: 'Acción de frenado es…', HB: 'Coeficiente de rozamiento es…', HC: 'Cubierta de nieve compactada',
    HD: 'Cubierta de nieve seca', HE: 'Cubierta de agua', HF: 'Totalmente libre de nieve/hielo',
    HG: 'Corte de hierba en curso', HH: 'Peligro debido a…', HI: 'Cubierta de hielo', HJ: 'Lanzamiento previsto',
    HK: 'Migración de aves en curso', HL: 'Limpieza de nieve completada', HM: 'Marcado por…',
    HN: 'Cubierta de nieve húmeda/aguanieve', HO: 'Oscurecido por nieve', HP: 'Limpieza de nieve en curso',
    HQ: 'Operación cancelada', HR: 'Agua estancada', HS: 'Esparcido de arena en curso',
    HT: 'Aproximación según área de señales', HU: 'Lanzamiento en curso', HV: 'Trabajos completados',
    HW: 'Trabajos en curso', HX: 'Concentración de aves', HY: 'Bancos de nieve', HZ: 'Surcos/crestas heladas',
    // Limitaciones (L)
    LA: 'Operando con energía auxiliar', LB: 'Reservado a aeronaves con base en el aeródromo', LC: 'Cerrado',
    LD: 'Inseguro', LE: 'Operando sin energía auxiliar', LF: 'Interferencia de…', LG: 'Operando sin identificación',
    LH: 'Fuera de servicio para aeronaves más pesadas que…', LI: 'Cerrado a operaciones IFR', LK: 'Operando como luz fija',
    LL: 'Utilizable, longitud/anchura…', LN: 'Cerrado a toda operación nocturna', LP: 'Prohibido a…',
    LR: 'Aeronaves restringidas a pistas y calles de rodaje', LS: 'Sujeto a interrupción', LT: 'Limitado a…',
    LV: 'Cerrado a operaciones VFR', LW: 'Tendrá lugar', LX: 'Operativo, precaución por…',
    // Otros
    XX: 'Texto libre (ver cuerpo del NOTAM)', TT: 'Ver cuerpo del NOTAM',
  };

  const SUBJ_GROUP = {
    A: 'Organización del espacio aéreo / ATM', C: 'Comunicaciones y vigilancia', F: 'Instalaciones y servicios',
    G: 'GNSS', I: 'ILS/MLS', L: 'Iluminación', M: 'Área de movimiento y aterrizaje', N: 'Radioayudas',
    O: 'Otros', P: 'Procedimientos ATM', R: 'Restricciones de espacio aéreo', S: 'Servicios de tránsito aéreo',
    W: 'Avisos de navegación / actividades',
  };

  const TRAFFIC = { I: 'IFR', V: 'VFR', K: 'Checklist' };
  const PURPOSE = {
    N: 'Selección inmediata (NOTAMN)', B: 'De interés para el briefing (PIB)',
    O: 'Relativo a operaciones de vuelo', M: 'Misceláneo', K: 'Checklist',
  };
  const SCOPE = { A: 'Aeródromo', E: 'En ruta', W: 'Aviso de navegación', K: 'Checklist' };

  function decodeQ(qcode) {
    const raw = qcode || '';
    const q = raw.toUpperCase().replace(/[^A-Z]/g, '');
    if (q.length < 5 || q[0] !== 'Q') {
      return { code: raw, subject: '', condition: '', text: raw || '—' };
    }
    const sub = q.substr(1, 2), cond = q.substr(3, 2);
    const subject = SUBJECT[sub] || (SUBJ_GROUP[sub[0]] ? SUBJ_GROUP[sub[0]] + ' (' + sub + ')' : sub);
    const condition = CONDITION[cond] || cond;
    return { code: q, subject: subject, condition: condition, text: subject + ' · ' + condition };
  }

  function decodeMulti(s, map) {
    if (!s) return '';
    return String(s).toUpperCase().replace(/[^A-Z]/g, '').split('')
      .map((c) => map[c] || c).join(' · ');
  }
  function decodeTraffic(s) { return decodeMulti(s, TRAFFIC); }
  function decodePurpose(s) { return decodeMulti(s, PURPOSE); }
  function decodeScope(s) { return decodeMulti(s, SCOPE); }

  return { decodeQ, decodeTraffic, decodePurpose, decodeScope, SUBJECT, CONDITION };
})();
