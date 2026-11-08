/* BOUNDARY / Lifeguard — panel de la conversación supervisada (sólo lectura).
 *
 * Fuente ÚNICA de datos: la sesión de continuidad.
 *   POST /api/continuity/tasks        body {}  -> { session }   (src/server.ts:593)
 *   GET  /api/continuity/tasks/:id              -> { session }  (src/server.ts:584 y ss.)
 *   GET  /api/continuity/status                 -> { enabled, ... }
 *
 * Este fichero NO llama a /api/state: esa ruta no existe en el router
 * (API_ROUTES, src/contracts.ts:1140-1148). El contrato completo del panel y el
 * origen exacto de cada campo está en docs/sprint/panel-contract.md.
 *
 * Ciclo de rescate: se pinta SÓLO con estos campos, y cada uno tiene su origen
 * (números de línea de la copia actual; el símbolo entre paréntesis manda si el
 * backend se mueve):
 *   detected                -> DETECTED / NO_INTERVENTION_NEEDED  (src/continuity.ts:313-314, 839)
 *   intervention.sent       -> INTERVENTION_SENT                  (cloneSession, src/continuity.ts:832)
 *   intervention.received   -> INTERVENTION_RECEIVED              (cloneSession, src/continuity.ts:833)
 *   intervention.resumed    -> RESUMED                            (cloneSession, src/continuity.ts:834)
 *   intervention.resolved + verification.passed === true
 *                           -> RESOLVED                           (src/continuity.ts:835 + 837)
 *   verification.passed === false
 *                           -> UNRESOLVED                         (src/continuity.ts:837)
 *   status === 'completed' NO significa RESOLVED y aquí nunca se usa para eso.
 *
 * Reglas que este bloque no negocia:
 *  1. textContent siempre; en ningún punto se usa innerHTML.
 *  2. Nada fabricado. Campo ausente -> «sin dato» (UNKNOWN), nunca un estado.
 *  3. Cuatro hechos distintos se pintan distinto:
 *       policy   = seguridad aplicada        (eventos `policy`, src/continuity.ts:1390)
 *       guard    = intervención efectuada    (intervention.sent + eventos `guard`)
 *       resumed  = progreso                  (intervention.resumed)
 *       resolved = tarea resuelta            (intervention.resolved + verification.passed)
 *  4. El guardia no es el resultado: que escriba no resuelve nada.
 *  5. La llave de operador vive sólo en el campo password de esta pestaña, no se
 *     guarda, no se registra y sólo viaja en la cabecera X-Continuity-Key.
 */
(function () {
  'use strict';

  var BASE = '/api/continuity';
  /* La API tiene un límite global de ~60 peticiones/min: con un sondeo cada 2 s
     quedan 30/min de margen. Ante un 429 el intervalo sube (8 s -> 30 s). */
  var POLL_MS = 2000;
  var BACKOFF_START_MS = 8000;
  var BACKOFF_MAX_MS = 30000;
  var TIMEOUT_MS = 8000;
  var MAX_POLL_FAILURES = 5;

  var EVENT_LABEL = {
    worker: 'Worker',
    tool: 'Tool',
    policy: 'Policy',
    guard: 'Guard',
    system: 'System',
    verification: 'Verification'
  };
  var STATUS_LABEL = {
    queued: 'En cola',
    running: 'En ejecución',
    blocked: 'Bloqueada',
    completed: 'Completada',
    failed: 'Fallida'
  };
  var STATUS_TONE = {
    queued: 'info',
    running: 'info',
    blocked: 'warn',
    completed: 'neutral',
    failed: 'critical'
  };
  var LIVE_STATUS = { queued: true, running: true };
  var TERMINAL_STATUS = { completed: true, failed: true, blocked: true };

  /* --- Ciclo de rescate: 7 estados, cada uno con su campo y su tono --------- */

  var SEQUENCE = [
    {
      id: 'DETECTED',
      tone: 'detected',
      glyph: '◔',
      label: 'Fallo detectado',
      plain: 'El guardia vio que el worker estaba atascado y decidió intervenir.',
      source: 'detected',
      optional: true
    },
    {
      id: 'INTERVENTION_SENT',
      tone: 'sent',
      glyph: '▲',
      label: 'Intervención enviada',
      plain: 'El mensaje del guardia entró en la conversación de la tarea.',
      source: 'intervention.sent',
      optional: false
    },
    {
      id: 'INTERVENTION_RECEIVED',
      tone: 'received',
      glyph: '◆',
      label: 'Intervención recibida',
      plain: 'El worker incluyó ese mensaje en una de sus peticiones reales al modelo.',
      source: 'intervention.received',
      optional: false
    },
    {
      id: 'RESUMED',
      tone: 'resumed',
      glyph: '▶',
      label: 'Trabajo reanudado',
      plain: 'Después del mensaje, el worker volvió a ejecutar una herramienta permitida.',
      source: 'intervention.resumed',
      optional: false
    }
  ];

  var OUTCOMES = [
    {
      id: 'RESOLVED',
      tone: 'resolved',
      glyph: '✔',
      label: 'Tarea resuelta',
      plain: 'El bloqueo quedó superado y la verificación del servidor pasó.',
      source: 'intervention.resolved + verification.passed',
      optional: false
    },
    {
      id: 'UNRESOLVED',
      tone: 'unresolved',
      glyph: '✖',
      label: 'No resuelta',
      plain: 'La verificación del servidor falló, o el servidor informa que no quedó resuelta.',
      source: 'verification.passed = false',
      optional: false
    },
    {
      id: 'NO_INTERVENTION_NEEDED',
      tone: 'none',
      glyph: '≡',
      label: 'Sin intervención necesaria',
      plain: 'El guardia no detectó ningún atasco: no hubo nada que rescatar.',
      source: 'detected = false',
      optional: true
    }
  ];

  var els = null;
  var session = null;
  var seen = Object.create(null);
  var pollTimer = null;
  var polling = false;
  var starting = false;
  var pollFailures = 0;
  var backoffMs = 0;      // espera extra impuesta por un 429
  var enabled = null;     // enabled de /status; null = no confirmado
  var statusBody = null;
  var statusKnown = false;
  var statusReason = null;

  /* --------------------------------------------------------------- Utilidades */

  function byId(id) {
    return document.getElementById(id);
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i += 1) append(node, children[i]);
      return;
    }
    if (children instanceof Node) {
      node.appendChild(children);
      return;
    }
    node.appendChild(document.createTextNode(String(children)));
  }

  /* createElement + textContent: 'text' es siempre texto, nunca marcado. */
  function mk(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = String(value);
        else if (key === 'text') node.textContent = String(value);
        else node.setAttribute(key, String(value));
      });
    }
    append(node, children);
    return node;
  }

  function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function field(obj, key) {
    if (!isObj(obj)) return undefined;
    return obj[key];
  }

  function textOr(value, fallback) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return fallback;
  }

  /* booleano estricto: true, false o null (= el campo no vino / no es booleano) */
  function boolOf(value) {
    return typeof value === 'boolean' ? value : null;
  }

  function numOf(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function scalar(value) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'sí' : 'no';
    if (value === null) return 'null';
    return null;
  }

  function messageOf(error) {
    if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
    return String(error);
  }

  function safeClass(value) {
    var text = typeof value === 'string' ? value.toLowerCase() : '';
    return /^[a-z-]{1,24}$/.test(text) ? text : 'system';
  }

  function badge(label, tone) {
    return mk('span', { class: 'badge badge--' + (tone || 'neutral'), text: label });
  }

  function note(kind, text) {
    return mk('p', { class: 'note note--' + kind, text: text });
  }

  function kv(pairs) {
    var dl = mk('dl', { class: 'kv' });
    pairs.forEach(function (pair) {
      if (!pair) return;
      dl.appendChild(mk('div', { class: 'kv__row' }, [
        mk('dt', { class: 'kv__key', text: pair[0] }),
        mk('dd', { class: 'kv__val' }, pair[1])
      ]));
    });
    return dl;
  }

  function details(label, value) {
    if (value === undefined) return null;
    var text;
    try {
      text = JSON.stringify(value, null, 2);
    } catch (error) {
      text = messageOf(error);
    }
    if (typeof text !== 'string') text = String(value);
    if (text.length > 4000) text = text.slice(0, 4000) + '\n… (truncado)';
    return mk('details', null, [
      mk('summary', { text: label }),
      mk('pre', { text: text })
    ]);
  }

  function stamp(value) {
    if (typeof value !== 'string' || value.length === 0) return 'hora ausente';
    var date = new Date(value);
    if (isNaN(date.getTime())) return value + ' (no es una fecha ISO válida)';
    return date.toLocaleTimeString() + ' · ' + value;
  }

  function fmtNum(value) {
    if (value === null) return 'sin dato';
    var parts = String(Math.round(value)).split('');
    var out = '';
    for (var i = 0; i < parts.length; i += 1) {
      var remaining = parts.length - i;
      out += parts[i];
      if (remaining > 1 && remaining % 3 === 1) out += '.';
    }
    return out;
  }

  /* Duración legible. Si falta finishedAt y la sesión sigue viva, se marca como
     en curso: el panel no presenta un tiempo final que el servidor no dio. */
  function durationText(startedAt, finishedAt, live) {
    if (typeof startedAt !== 'string') return 'sin dato';
    var start = new Date(startedAt).getTime();
    if (isNaN(start)) return 'sin dato';
    var end = typeof finishedAt === 'string' ? new Date(finishedAt).getTime() : NaN;
    var running = false;
    if (isNaN(end)) {
      if (!live) return 'sin dato';
      end = Date.now();
      running = true;
    }
    var ms = end - start;
    if (!isFinite(ms) || ms < 0) return 'sin dato';
    var totalSeconds = Math.round(ms / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    var text = minutes > 0 ? minutes + ' min ' + seconds + ' s' : seconds + ' s';
    return running ? text + ' (en curso, sin finishedAt)' : text;
  }

  function apiMessage(result) {
    var data = field(result, 'data');
    var reason = textOr(field(data, 'error'), null);
    return reason ? ' Mensaje de la API: ' + reason : '';
  }

  /* --------------------------------------------------- Lectura estricta de datos */

  /* Único punto donde se decide qué está probado. Nada se deduce del texto de un
     evento ni del status de la sesión. */
  function readFacts() {
    if (!session) {
      return {
        hasSession: false,
        status: null,
        detected: null,
        sent: null,
        received: null,
        resumed: null,
        resolved: null,
        passed: null,
        detail: null,
        withheld: null,
        guardCalls: null,
        guardTokens: null,
        startedAt: null,
        finishedAt: null,
        terminal: false,
        live: false
      };
    }
    var intervention = field(session, 'intervention');
    var verification = field(session, 'verification');
    var status = textOr(field(session, 'status'), null);
    return {
      hasSession: true,
      status: status,
      detected: boolOf(field(session, 'detected')),
      sent: boolOf(field(intervention, 'sent')),
      received: boolOf(field(intervention, 'received')),
      resumed: boolOf(field(intervention, 'resumed')),
      resolved: boolOf(field(intervention, 'resolved')),
      passed: boolOf(field(verification, 'passed')),
      detail: textOr(field(verification, 'detail'), null),
      withheld: textOr(field(session, 'withheld'), null),
      guardCalls: numOf(field(session, 'guardCalls')),
      guardTokens: numOf(field(session, 'guardTokens')),
      startedAt: textOr(field(session, 'startedAt'), null),
      finishedAt: textOr(field(session, 'finishedAt'), null),
      terminal: TERMINAL_STATUS[status] === true,
      live: LIVE_STATUS[status] === true
    };
  }

  function countEvents(type, predicate) {
    var events = field(session, 'events');
    if (!Array.isArray(events)) return 0;
    var total = 0;
    for (var i = 0; i < events.length; i += 1) {
      if (textOr(field(events[i], 'type'), '') !== type) continue;
      if (typeof predicate === 'function' && predicate(events[i]) !== true) continue;
      total += 1;
    }
    return total;
  }

  /* Veredicto por estado: 'on' probado, 'off' negado, 'unknown' sin dato. */
  function verdicts(facts) {
    var resolvedOn = facts.resolved === true && facts.passed === true;
    /* 'off' sólo con un FALSE explícito del servidor: un campo ausente es SIN DATO. */
    var resolvedOff = facts.resolved === false || facts.passed === false;
    var unresolvedOn = facts.passed === false ||
      (facts.resolved === false && facts.terminal === true);
    var unresolvedUnknown = facts.passed === null && facts.resolved === null;
    return {
      DETECTED: facts.detected === true ? 'on' : facts.detected === false ? 'off' : 'unknown',
      INTERVENTION_SENT: facts.sent === true ? 'on' : facts.sent === false ? 'off' : 'unknown',
      INTERVENTION_RECEIVED: facts.received === true ? 'on' : facts.received === false ? 'off' : 'unknown',
      RESUMED: facts.resumed === true ? 'on' : facts.resumed === false ? 'off' : 'unknown',
      RESOLVED: resolvedOn ? 'on' : resolvedOff ? 'off' : 'unknown',
      UNRESOLVED: unresolvedOn ? 'on' : unresolvedUnknown ? 'unknown' : 'off',
      NO_INTERVENTION_NEEDED: facts.detected === false ? 'on'
        : facts.detected === true ? 'off' : 'unknown'
    };
  }

  /* Estado actual del ciclo: el último peldaño probado; si hay desenlace, manda. */
  function currentState(facts, map) {
    if (!facts.hasSession) return 'UNKNOWN';
    if (map.RESOLVED === 'on') return 'RESOLVED';
    if (map.UNRESOLVED === 'on') return 'UNRESOLVED';
    if (map.NO_INTERVENTION_NEEDED === 'on') return 'NO_INTERVENTION_NEEDED';
    var last = null;
    for (var i = 0; i < SEQUENCE.length; i += 1) {
      if (map[SEQUENCE[i].id] === 'on') last = SEQUENCE[i].id;
    }
    return last === null ? 'UNKNOWN' : last;
  }

  /* ---------------------------------------------------------------- Tabla de uso */

  /* Tokens por rol, leídos de los eventos que ya trae la sesión
     (data.usage.promptTokens / completionTokens, emitido en
     createMeteredFetch, src/continuity.ts:1131-1144; campo `usage` en 1140). */
  function usageByRole() {
    var events = field(session, 'events');
    var roles = { worker: { calls: 0, prompt: 0, completion: 0, known: 0 }, guard: { calls: 0, prompt: 0, completion: 0, known: 0 } };
    if (!Array.isArray(events)) return roles;
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (!isObj(event)) continue;
      var type = textOr(field(event, 'type'), '');
      if (type !== 'worker' && type !== 'guard') continue;
      var usage = field(field(event, 'data'), 'usage');
      if (usage === undefined) continue;
      var bucket = type === 'worker' ? roles.worker : roles.guard;
      bucket.calls += 1;
      if (!isObj(usage)) continue;
      var prompt = numOf(field(usage, 'promptTokens'));
      var completion = numOf(field(usage, 'completionTokens'));
      if (prompt === null && completion === null) continue;
      bucket.known += 1;
      bucket.prompt += prompt === null ? 0 : prompt;
      bucket.completion += completion === null ? 0 : completion;
    }
    return roles;
  }

  /* --------------------------------------------------------------- Red / HTTP */

  function operatorKey() {
    if (!els || !els.key) return '';
    var value = typeof els.key.value === 'string' ? els.key.value.trim() : '';
    return value;
  }

  function request(method, path, body) {
    var headers = { accept: 'application/json' };
    if (method !== 'GET' && method !== 'HEAD') headers['content-type'] = 'application/json';
    var key = operatorKey();
    if (key !== '') headers['X-Continuity-Key'] = key;

    var options = {
      method: method,
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store'
    };
    if (body !== undefined) options.body = JSON.stringify(body);

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;

    return new Promise(function (resolve) {
      var settled = false;
      function settle(result) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(result);
      }
      if (controller) {
        options.signal = controller.signal;
        timer = setTimeout(function () {
          try { controller.abort(); } catch (error) { /* ignore */ }
        }, TIMEOUT_MS);
      }
      fetch(path, options).then(function (response) {
        return response.text().then(function (text) {
          return { response: response, text: text };
        });
      }).then(function (result) {
        var data = null;
        var invalidJson = false;
        if (result.text.length > 0) {
          try {
            data = JSON.parse(result.text);
          } catch (error) {
            invalidJson = true;
          }
        }
        settle({
          ok: result.response.ok,
          status: result.response.status,
          statusText: result.response.statusText || '',
          data: isObj(data) ? data : null,
          invalidJson: invalidJson || (result.text.length > 0 && !isObj(data)),
          empty: result.text.length === 0
        });
      }).catch(function (error) {
        var aborted = error && error.name === 'AbortError';
        settle({
          ok: false,
          status: 0,
          statusText: '',
          data: null,
          networkError: aborted
            ? 'la petición superó ' + TIMEOUT_MS / 1000 + ' s sin respuesta'
            : messageOf(error)
        });
      });
    });
  }

  /* -------------------------------------------------------------- Mensajería */

  function setError(title, detail) {
    if (!els || !els.errors) return;
    if (!title) {
      els.errors.hidden = true;
      els.errors.textContent = '';
      return;
    }
    els.errors.hidden = false;
    els.errors.textContent = '';
    append(els.errors, [
      mk('p', { class: 'lg-errors__title', text: title }),
      detail ? mk('p', { class: 'lg-errors__detail', text: detail }) : null
    ]);
  }

  function setConnection(tone, text) {
    var node = byId('connection');
    var detail = byId('connection-detail');
    if (node) {
      node.className = 'conn conn--' + tone;
      node.textContent = text;
    }
    if (detail) detail.textContent = text;
  }

  function revealKey(show) {
    if (!els || !els.keyWrap || !els.keyToggle) return;
    els.keyWrap.hidden = !show;
    els.keyToggle.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      if (els.key) els.key.focus();
      return;
    }
    /* Al cerrar el campo la llave se descarta: no se retiene en el DOM ni en JS. */
    if (els.key) els.key.value = '';
  }

  function refreshControls() {
    if (!els) return;
    var status = session ? field(session, 'status') : null;
    var live = LIVE_STATUS[status] === true;
    if (els.start) {
      els.start.disabled = starting || live || enabled === false;
      els.start.setAttribute('aria-busy', starting || live ? 'true' : 'false');
    }
    if (els.refresh) els.refresh.disabled = starting || polling || !session;
  }

  /* ------------------------------------------------------------------ Sondeo */

  function stopPoll() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll() {
    stopPoll();
    if (!session) return;
    if (LIVE_STATUS[field(session, 'status')] !== true) return;
    var delay = backoffMs > 0 ? Math.max(POLL_MS, backoffMs) : POLL_MS;
    pollTimer = setTimeout(function () {
      pollTimer = null;
      loadSession(true);
    }, delay);
  }

  function noteBackoff(where) {
    backoffMs = backoffMs > 0 ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
    setError('La API limitó el ritmo (HTTP 429)',
      'El servidor rechazó ' + where + ' por exceso de peticiones. El panel baja el ritmo a una consulta cada ' +
      backoffMs / 1000 + ' s y no reintenta en bucle: el registro no se toca y no se rellena nada.');
  }

  function resetSession() {
    stopPoll();
    session = null;
    seen = Object.create(null);
    pollFailures = 0;
    backoffMs = 0;
    if (els && els.log) els.log.textContent = '';
    renderAll();
    renderLogEmpty();
  }

  function acceptSession(fresh) {
    var id = textOr(field(fresh, 'id'), null);
    if (id === null) {
      setError('Sesión sin id utilizable',
        'La API entregó un objeto de sesión sin id: el panel no puede sondearla y no presenta sus eventos como evidencia.');
      return;
    }
    var previous = session ? textOr(field(session, 'id'), null) : null;
    if (previous !== id) {
      /* Sesión distinta: el registro y la deduplicación se reinician. */
      seen = Object.create(null);
      pollFailures = 0;
      if (els && els.log) els.log.textContent = '';
    }
    session = fresh;
    appendEvents(field(fresh, 'events'));
    renderAll();
    renderLogEmpty();
    refreshControls();
    schedulePoll();
  }

  function appendEvents(events) {
    if (!els || !els.log) return 0;
    var list = Array.isArray(events) ? events : [];
    var added = 0;
    for (var i = 0; i < list.length; i += 1) {
      var event = list[i];
      if (!isObj(event)) continue;
      var id = textOr(field(event, 'id'), null);
      /* Sin id (no debería ocurrir) se usa la posición, estable porque el
         servidor sólo añade eventos al final. */
      var key = id !== null ? 'id:' + id : 'pos:' + i;
      if (seen[key] === true) continue;
      seen[key] = true;
      els.log.appendChild(eventNode(event));
      added += 1;
    }
    return added;
  }

  function eventNode(event) {
    var type = textOr(field(event, 'type'), 'system');
    var cls = safeClass(type);
    var data = field(event, 'data');
    var children = [
      mk('div', { class: 'lg-event__meta' }, [
        mk('span', { class: 'lg-event__type lg-event__type--' + cls, text: textOr(EVENT_LABEL[type], type) }),
        mk('span', { class: 'lg-event__at', text: stamp(field(event, 'at')) }),
        mk('code', { class: 'lg-event__session', text: 'sesión ' + textOr(field(event, 'sessionId'), 'ausente') })
      ]),
      mk('p', { class: 'lg-event__text', text: textOr(field(event, 'text'), '(el evento no trae texto; el panel no lo rellena)') })
    ];
    if (cls === 'guard') {
      children.push(mk('p', {
        class: 'lg-event__opinion',
        text: 'Mensaje del guardia: no es el resultado de la tarea ni marca la sesión como resuelta.'
      }));
    }
    if (data !== undefined) children.push(details('datos del evento', data));
    return mk('li', { class: 'lg-event lg-event--' + cls }, children);
  }

  /* ------------------------------------------------------------------ Render */

  function renderLogEmpty() {
    if (!els || !els.logEmpty || !els.log) return;
    els.logEmpty.hidden = els.log.children.length > 0;
  }

  function renderStatus(note_) {
    if (!els || !els.status) return;
    els.status.textContent = '';
    var nodes = [];
    if (note_) nodes.push(mk('p', { class: 'lg-status__note', text: note_ }));

    if (enabled === false) {
      nodes.push(mk('p', {
        class: 'note note--missing',
        text: 'GET ' + BASE + '/status informa enabled:false' + (statusReason ? ' (' + statusReason + ')' : '') +
          ': el servidor no habilitó la continuidad, así que el botón queda deshabilitado.'
      }));
    } else if (statusKnown && enabled === null) {
      nodes.push(mk('p', {
        class: 'note note--missing',
        text: 'No se pudo confirmar el estado de continuidad: GET ' + BASE + '/status no entregó un enabled booleano. El botón sigue disponible; si la ruta no existe, la creación fallará y el error se mostrará arriba, sin datos de ejemplo.'
      }));
    }

    if (session) {
      var status = textOr(field(session, 'status'), 'ausente');
      nodes.push(mk('div', { class: 'lg-status__line' }, [
        mk('span', { class: 'lg-status__label', text: 'Estado de la sesión' }),
        badge(textOr(STATUS_LABEL[status], 'Estado: ' + status), textOr(STATUS_TONE[status], 'neutral')),
        mk('span', { class: 'lg-status__id', text: textOr(field(session, 'id'), 'id ausente') })
      ]));
      var count = els.log ? els.log.children.length : 0;
      nodes.push(mk('p', {
        class: 'lg-status__count',
        text: count + (count === 1 ? ' evento recibido' : ' eventos recibidos') +
          (LIVE_STATUS[status] === true ? ' · sondeo cada ' + POLL_MS / 1000 + ' s' : ' · sondeo detenido')
      }));
    } else if (!note_) {
      nodes.push(mk('p', {
        class: 'placeholder',
        text: 'Sin sesión: todavía no hay ninguna tarea supervisada que mostrar. No se enseñan datos de ejemplo.'
      }));
    }

    var facts = [];
    if (isObj(statusBody)) {
      ['mode', 'model'].forEach(function (key) {
        var value = scalar(statusBody[key]);
        if (value === null) return;
        facts.push([key, mk('span', { text: value })]);
      });
    }
    if (facts.length > 0) nodes.push(kv(facts));
    if (isObj(statusBody)) nodes.push(details('Configuración y límites del servicio', statusBody));

    append(els.status, nodes);
  }

  var STATE_TEXT = {
    DETECTED: 'Fallo detectado — el guardia aún no ha enviado nada',
    INTERVENTION_SENT: 'El guardia envió una intervención',
    INTERVENTION_RECEIVED: 'El worker recibió la intervención',
    RESUMED: 'El worker reanudó el trabajo',
    RESOLVED: 'Tarea resuelta — resuelta por el servidor y verificada',
    UNRESOLVED: 'No resuelta',
    NO_INTERVENTION_NEEDED: 'No hizo falta intervención',
    UNKNOWN: 'Sin dato suficiente'
  };

  /* Frase única, para que se entienda en diez segundos y sin jerga. */
  function renderVerdict() {
    if (!els || !els.verdict) return;
    els.verdict.textContent = '';
    var facts = readFacts();
    if (!facts.hasSession) {
      els.verdict.appendChild(mk('p', {
        class: 'placeholder',
        text: 'Sin sesión: no hay nada que resumir. El panel no inventa un resultado.'
      }));
      return;
    }
    var map = verdicts(facts);
    var state = currentState(facts, map);
    var policyCount = countEvents('policy', null);
    var guardCount = countEvents('guard', null);

    els.verdict.appendChild(mk('div', { class: 'verdict__head' }, [
      mk('span', { class: 'verdict__glyph verdict__glyph--' + state.toLowerCase(), 'aria-hidden': 'true', text: glyphFor(state) }),
      mk('p', { class: 'verdict__state', text: STATE_TEXT[state] }),
      mk('code', { class: 'verdict__code', text: state })
    ]));

    var parts = [];
    if (policyCount > 0) {
      parts.push('La política de seguridad bloqueó o denegó ' + policyCount +
        (policyCount === 1 ? ' operación' : ' operaciones') + '.');
    } else {
      parts.push('La sesión no registra eventos de política.');
    }
    if (facts.sent === true) {
      parts.push(guardCount > 0
        ? 'El guardia escribió ' + guardCount + (guardCount === 1 ? ' mensaje' : ' mensajes') + ' de intervención.'
        : 'El servidor informa la intervención como enviada.');
    } else if (facts.sent === false) {
      parts.push('No se envió ninguna intervención.');
    } else {
      parts.push('El servidor no informa si hubo intervención.');
    }
    if (facts.resumed === true) parts.push('El worker volvió a trabajar después del mensaje.');
    if (facts.passed === true) parts.push('La verificación final del servidor pasó.');
    else if (facts.passed === false) parts.push('La verificación final del servidor falló.');
    else parts.push('La verificación final no está informada.');

    els.verdict.appendChild(mk('p', { class: 'verdict__text', text: parts.join(' ') }));
    if (facts.withheld !== null) {
      els.verdict.appendChild(mk('p', {
        class: 'verdict__withheld',
        text: 'El guardia no emitió mensaje y declaró el motivo: ' + facts.withheld
      }));
    }
  }

  function glyphFor(state) {
    for (var i = 0; i < SEQUENCE.length; i += 1) if (SEQUENCE[i].id === state) return SEQUENCE[i].glyph;
    for (var j = 0; j < OUTCOMES.length; j += 1) if (OUTCOMES[j].id === state) return OUTCOMES[j].glyph;
    return '?';
  }

  var VERDICT_BADGE = {
    on: ['Cumplido', 'good'],
    off: ['No cumplido', 'neutral'],
    unknown: ['SIN DATO (UNKNOWN)', 'warn']
  };

  function stepNode(step, verdict, currentId) {
    var pair = VERDICT_BADGE[verdict] === undefined ? VERDICT_BADGE.unknown : VERDICT_BADGE[verdict];
    var isCurrent = verdict === 'on' && step.id === currentId;
    var node = mk('li', {
      class: 'tl tl--' + step.tone + ' tl--' + verdict + (isCurrent ? ' tl--current' : ''),
      'data-state': step.id
    }, [
      mk('span', { class: 'tl__mark', 'aria-hidden': 'true', text: step.glyph }),
      mk('div', { class: 'tl__body' }, [
        mk('p', { class: 'tl__head' }, [
          mk('span', { class: 'tl__code', text: step.id }),
          mk('span', { class: 'tl__label', text: step.label })
        ]),
        mk('p', { class: 'tl__plain', text: step.plain }),
        mk('p', { class: 'tl__source' }, [
          mk('span', { class: 'tl__field', text: 'campo: ' + step.source }),
          badge(pair[0], pair[1])
        ])
      ])
    ]);
    return node;
  }

  function renderTimeline() {
    if (!els || !els.timeline) return;
    els.timeline.textContent = '';
    var facts = readFacts();
    if (!facts.hasSession) {
      els.timeline.appendChild(mk('p', {
        class: 'placeholder',
        text: 'Sin sesión: el ciclo de rescate no se puede dibujar. Ningún estado se da por bueno sin su campo.'
      }));
      return;
    }
    var map = verdicts(facts);
    var current = currentState(facts, map);

    var seq = mk('ol', { class: 'tl-list tl-list--seq', 'aria-label': 'Secuencia del rescate' });
    SEQUENCE.forEach(function (step) {
      seq.appendChild(stepNode(step, map[step.id], current));
    });
    els.timeline.appendChild(mk('div', { class: 'tl-group' }, [
      mk('h4', { class: 'tl-group__title', text: 'Secuencia del rescate (en orden)' }),
      seq
    ]));

    var outcomes = mk('ul', { class: 'tl-list tl-list--outcome', 'aria-label': 'Desenlace de la sesión' });
    OUTCOMES.forEach(function (step) {
      outcomes.appendChild(stepNode(step, map[step.id], current));
    });
    els.timeline.appendChild(mk('div', { class: 'tl-group' }, [
      mk('h4', { class: 'tl-group__title', text: 'Desenlace (sólo uno puede cumplirse)' }),
      outcomes
    ]));

    var unknown = [];
    SEQUENCE.concat(OUTCOMES).forEach(function (step) {
      if (map[step.id] === 'unknown' && step.optional) {
        unknown.push(step.source);
      }
    });
    if (unknown.length > 0) {
      els.timeline.appendChild(note('missing',
        'Campos opcionales que el servidor todavía no publica: ' + unknown.join(', ') +
        '. Esos estados quedan en SIN DATO; el panel no los deduce de ningún otro campo.'));
    }
    if (facts.passed === null) {
      els.timeline.appendChild(note('missing',
        'verification.passed no viene informado (null o ausente): la tarea no se pinta como resuelta ni como no resuelta.'));
    }
    if (facts.status === 'completed' && map.RESOLVED !== 'on') {
      els.timeline.appendChild(note('missing',
        'status = completed NO se convierte en «tarea resuelta». RESOLVED exige intervention.resolved = true y verification.passed = true; el panel no sustituye uno por el otro.'));
    }
  }

  /* Cuatro hechos distintos, cuatro pintados distintos. */
  function renderSignals() {
    if (!els || !els.signals) return;
    els.signals.textContent = '';
    var facts = readFacts();
    if (!facts.hasSession) {
      els.signals.appendChild(mk('p', {
        class: 'placeholder',
        text: 'Sin sesión: no hay seguridad aplicada, intervención, progreso ni resultado que mostrar.'
      }));
      return;
    }
    var policyCount = countEvents('policy', null);
    var guardCount = countEvents('guard', null);
    var resolvedOn = facts.resolved === true && facts.passed === true;

    function card(signal, glyph, title, stateText, tone, meaning, source) {
      els.signals.appendChild(mk('div', { class: 'signal signal--' + signal + ' signal--' + tone, 'data-signal': signal }, [
        mk('p', { class: 'signal__head' }, [
          mk('span', { class: 'signal__glyph', 'aria-hidden': 'true', text: glyph }),
          mk('span', { class: 'signal__title', text: title })
        ]),
        mk('p', { class: 'signal__state', text: stateText }),
        mk('p', { class: 'signal__meaning', text: meaning }),
        mk('p', { class: 'signal__source', text: 'fuente: ' + source })
      ]));
    }

    card('policy', '■', 'Seguridad aplicada',
      policyCount > 0 ? policyCount + (policyCount === 1 ? ' operación bloqueada o denegada' : ' operaciones bloqueadas o denegadas')
        : 'Ninguna operación bloqueada registrada',
      policyCount > 0 ? 'on' : 'idle',
      'La política determinista impidió acciones. No es una intervención ni un progreso: es la barrera haciendo su trabajo.',
      'eventos policy (' + policyCount + ')');

    card('guard', '◆', 'Intervención efectuada',
      facts.sent === true ? 'El mensaje del guardia entró en la sesión'
        : facts.sent === false ? 'No se envió intervención'
          : 'SIN DATO (intervention.sent ausente)',
      facts.sent === true ? 'on' : facts.sent === false ? 'off' : 'unknown',
      'El guardia sólo escribe: no ejecuta herramientas, no concede permisos y su mensaje no resuelve la tarea.' +
        (guardCount > 0 ? ' Eventos del guardia en la sesión: ' + guardCount + '.' : ''),
      'intervention.sent + eventos guard (' + guardCount + ')');

    card('resumed', '▶', 'Progreso',
      facts.resumed === true ? 'El worker volvió a ejecutar tras el mensaje'
        : facts.resumed === false ? 'El worker no reanudó'
          : 'SIN DATO (intervention.resumed ausente)',
      facts.resumed === true ? 'on' : facts.resumed === false ? 'off' : 'unknown',
      'Progreso es volver a trabajar, no terminar. Una tarea puede reanudar y aun así no quedar resuelta.',
      'intervention.resumed');

    card('resolved', '✔', 'Tarea resuelta',
      resolvedOn ? 'Resuelta y verificada por el servidor'
        : facts.passed === false ? 'La verificación falló'
          : facts.resolved === true ? 'resolved = true, pero falta verification.passed'
            : facts.passed === true ? 'pass = true, pero falta intervention.resolved'
              : facts.resolved === false ? 'El servidor informa resolved = false'
                : 'SIN DATO (resolved + verification.passed)',
      resolvedOn ? 'on' : facts.passed === false ? 'off' : 'unknown',
      'Sólo aquí se dice «resuelta». Exige las dos cosas a la vez y nunca se lee de status.',
      'intervention.resolved + verification.passed');
  }

  function renderMeta() {
    if (!els || !els.meta) return;
    els.meta.textContent = '';
    var facts = readFacts();
    if (!facts.hasSession) {
      els.meta.appendChild(mk('p', { class: 'placeholder', text: 'Sin sesión: no hay campos que mostrar.' }));
      return;
    }
    var status = textOr(facts.status, 'ausente');
    var mode = textOr(field(session, 'mode'), null);
    els.meta.appendChild(kv([
      ['Sesión', mk('code', { text: textOr(field(session, 'id'), 'ausente') })],
      ['Estado informado', badge(textOr(STATUS_LABEL[status], status), textOr(STATUS_TONE[status], 'neutral'))],
      ['Modo', mk('span', {
        text: mode === null ? 'ausente'
          : mode + (mode === 'live' ? '' : ' — el contrato de esta tarea es mode:live')
      })],
      ['Inicio', facts.startedAt === null
        ? mk('span', { class: 'note note--missing', text: 'ausente' })
        : mk('span', { text: stamp(facts.startedAt) })],
      ['Fin', facts.finishedAt === null
        ? mk('span', { class: 'note note--missing', text: 'aún sin finishedAt' })
        : mk('span', { text: stamp(facts.finishedAt) })],
      ['Tiempo', mk('span', { text: durationText(facts.startedAt, facts.finishedAt, facts.live) })]
    ]));
    var error = field(session, 'error');
    if (typeof error === 'string' && error.length > 0) {
      els.meta.appendChild(note('error', 'Error informado por el servidor: ' + error));
    } else if (error !== undefined && error !== null) {
      els.meta.appendChild(details('error informado por el servidor', error));
    }
  }

  function renderUsage() {
    if (!els || !els.usage) return;
    els.usage.textContent = '';
    var facts = readFacts();
    if (!facts.hasSession) {
      els.usage.appendChild(mk('p', { class: 'placeholder', text: 'Sin sesión: no hay tokens ni tiempos que medir.' }));
      return;
    }
    var roles = usageByRole();
    var rows = [
      ['worker', 'Worker (modelo de trabajo)', roles.worker],
      ['guard', 'Guardia (Lifeguard)', roles.guard]
    ];
    var totalPrompt = 0;
    var totalCompletion = 0;
    var anyUsage = false;

    var body = mk('tbody');
    rows.forEach(function (row) {
      var bucket = row[2];
      if (bucket.known > 0) {
        anyUsage = true;
        totalPrompt += bucket.prompt;
        totalCompletion += bucket.completion;
      }
      body.appendChild(mk('tr', null, [
        mk('th', { scope: 'row', text: row[1] }),
        mk('td', { text: bucket.calls > 0 ? String(bucket.calls) : '0' }),
        mk('td', { text: bucket.known > 0 ? fmtNum(bucket.prompt) : 'sin dato' }),
        mk('td', { text: bucket.known > 0 ? fmtNum(bucket.completion) : 'sin dato' })
      ]));
    });
    if (anyUsage) {
      body.appendChild(mk('tr', { class: 'usage__total' }, [
        mk('th', { scope: 'row', text: 'Total' }),
        mk('td', { text: '' }),
        mk('td', { text: fmtNum(totalPrompt) }),
        mk('td', { text: fmtNum(totalCompletion) })
      ]));
    }

    els.usage.appendChild(mk('table', { class: 'table' }, [
      mk('thead', null, [
        mk('tr', null, [
          mk('th', { scope: 'col', text: 'Rol' }),
          mk('th', { scope: 'col', text: 'Llamadas informadas' }),
          mk('th', { scope: 'col', text: 'Tokens de entrada' }),
          mk('th', { scope: 'col', text: 'Tokens de salida' })
        ])
      ]),
      body
    ]));

    els.usage.appendChild(mk('p', {
      class: 'lg-help',
      text: 'Los tokens se suman de los eventos que ya vienen en la sesión (data.usage de cada llamada al modelo). '
        + 'Si el servidor no informó usage, la celda dice «sin dato»: el panel no estima cifras.'
    }));

    var extras = [];
    if (facts.guardCalls !== null) extras.push(['Llamadas del guardia (guardCalls)', mk('span', { text: fmtNum(facts.guardCalls) })]);
    if (facts.guardTokens !== null) extras.push(['Tokens del guardia (guardTokens)', mk('span', { text: fmtNum(facts.guardTokens) })]);
    if (extras.length > 0) els.usage.appendChild(kv(extras));

    els.usage.appendChild(kv([
      ['Inicio', mk('span', { text: facts.startedAt === null ? 'sin dato' : stamp(facts.startedAt) })],
      ['Fin', mk('span', { text: facts.finishedAt === null ? 'sin dato (aún sin finishedAt)' : stamp(facts.finishedAt) })],
      ['Tiempo total', mk('span', { text: durationText(facts.startedAt, facts.finishedAt, facts.live) })]
    ]));
    if (!anyUsage) {
      els.usage.appendChild(note('missing',
        'La sesión no trae ningún data.usage: los tokens quedan sin dato. El panel no los calcula ni los estima.'));
    }
  }

  function flag(name, label, value, meaning) {
    var text = value === true ? 'sí' : value === false ? 'no' : 'sin dato';
    var tone = value === true ? 'good' : value === false ? 'neutral' : 'warn';
    return mk('div', { class: 'lg-flag', 'data-flag': name }, [
      mk('span', { class: 'lg-flag__label', text: label }),
      badge(text, tone),
      mk('span', { class: 'lg-flag__meaning', text: meaning })
    ]);
  }

  function renderIntervention() {
    if (!els || !els.intervention) return;
    els.intervention.textContent = '';
    els.intervention.appendChild(mk('h3', { class: 'lg-block__title', text: 'Campos de la intervención del guardia' }));
    var facts = readFacts();
    if (!facts.hasSession) {
      els.intervention.appendChild(mk('p', {
        class: 'placeholder',
        text: 'Sin intervención registrada: no hay sesión.'
      }));
      return;
    }

    els.intervention.appendChild(mk('div', { class: 'lg-flags' }, [
      flag('sent', 'sent — enviado', facts.sent, 'El mensaje entró en la conversación de la sesión.'),
      flag('received', 'received — recibido', facts.received, 'El worker lo incluyó en una petición real al modelo.'),
      flag('resumed', 'resumed — reanudado', facts.resumed, 'Después del mensaje, el worker volvió a ejecutar.'),
      flag('resolved', 'resolved — resuelto', facts.resolved, 'El bloqueo concreto quedó superado; sólo cuenta con la verificación en PASS.')
    ]));

    if (facts.received === true && facts.sent !== true) {
      els.intervention.appendChild(note('missing',
        'El servidor informa received = true con sent ≠ true. El panel lo muestra tal cual y no corrige la contradicción.'));
    }
    if (facts.resumed === true && facts.received !== true) {
      els.intervention.appendChild(note('missing',
        'El servidor informa resumed = true con received ≠ true: el panel no deduce causalidad desde el texto.'));
    }
    if (facts.resolved === true && !(facts.passed === true && facts.status === 'completed')) {
      els.intervention.appendChild(note('missing',
        'El servidor informa resolved = true, pero la verificación no es un PASS con status = completed. El panel no presenta la tarea como resuelta por ello.'));
    }
    if (facts.sent !== true && facts.received !== true && facts.resumed !== true && facts.resolved !== true) {
      els.intervention.appendChild(mk('p', {
        class: 'placeholder',
        text: facts.sent === false
          ? 'El servidor informa que no hubo intervención del guardia en esta sesión.'
          : 'El servidor no informa ninguna intervención del guardia en esta sesión.'
      }));
    }
  }

  function renderVerification() {
    if (!els || !els.verification) return;
    els.verification.textContent = '';
    els.verification.appendChild(mk('h3', { class: 'lg-block__title', text: 'Verificación final' }));
    var facts = readFacts();
    if (!facts.hasSession) {
      els.verification.appendChild(mk('p', { class: 'placeholder', text: 'Sin verificación: no hay sesión.' }));
      return;
    }
    if (facts.passed === true && facts.status === 'completed') {
      els.verification.appendChild(note('ok',
        'PASS — el servidor informa verification.passed = true y status = completed.'));
    } else if (facts.passed === true) {
      els.verification.appendChild(note('missing',
        'El servidor informa verification.passed = true, pero el estado de la sesión es «' +
        textOr(facts.status, 'ausente') + '»: el panel no lo muestra como aprobado.'));
    } else if (facts.passed === false) {
      els.verification.appendChild(note('error',
        'FAIL — el servidor informa verification.passed = false.'));
    } else {
      els.verification.appendChild(note('missing',
        'Sin verificar: la API no informa verification.passed (null o ausente). El panel no convierte un mensaje del guardia en un resultado.'));
    }
    if (facts.detail !== null) {
      els.verification.appendChild(mk('p', { class: 'lg-detail', text: facts.detail }));
    } else {
      els.verification.appendChild(mk('p', {
        class: 'placeholder',
        text: 'La sesión no trae verification.detail.'
      }));
    }
    els.verification.appendChild(mk('p', {
      class: 'lg-help',
      text: 'El panel no ejecuta la verificación: sólo lee lo que el servidor comprobó en su propio entorno aislado.'
    }));
  }

  /* Evidencia: hashes de integridad que el servidor emitió como eventos
     `verification` (src/continuity.ts:1554-1559). Nada se recalcula aquí. */
  var HASH_KEYS = ['sourceBefore', 'sourceAfter', 'testsBefore', 'testsAfter', 'protectedBefore', 'protectedAfter'];

  function renderEvidence() {
    if (!els || !els.evidence) return;
    els.evidence.textContent = '';
    els.evidence.appendChild(mk('h3', { class: 'lg-block__title', text: 'Evidencia' }));
    var facts = readFacts();
    if (!facts.hasSession) {
      els.evidence.appendChild(mk('p', { class: 'placeholder', text: 'Sin evidencia: no hay sesión.' }));
      return;
    }
    var events = field(session, 'events');
    var blocks = [];
    if (Array.isArray(events)) {
      for (var i = 0; i < events.length; i += 1) {
        var event = events[i];
        if (!isObj(event)) continue;
        if (textOr(field(event, 'type'), '') !== 'verification') continue;
        var data = field(event, 'data');
        if (!isObj(data)) continue;
        var rows = [];
        HASH_KEYS.forEach(function (key) {
          var value = field(data, key);
          if (typeof value !== 'string' || value.length === 0) return;
          rows.push([key, mk('code', { class: 'hash', text: value })]);
        });
        if (rows.length > 0) {
          blocks.push(mk('div', { class: 'evidence' }, [
            mk('p', { class: 'evidence__at', text: 'Evento de verificación · ' + stamp(field(event, 'at')) }),
            kv(rows)
          ]));
        }
      }
    }
    if (blocks.length === 0) {
      els.evidence.appendChild(mk('p', {
        class: 'placeholder',
        text: 'La sesión no trae hashes de verificación (eventos verification con data.sourceBefore / sourceAfter / testsBefore / testsAfter).'
      }));
    } else {
      append(els.evidence, blocks);
      els.evidence.appendChild(mk('p', {
        class: 'lg-help',
        text: 'Estos hashes los emitió el servidor al verificar. El panel no los recalcula ni comprueba la identidad del modelo.'
      }));
    }
    if (facts.passed !== null) {
      els.evidence.appendChild(kv([
        ['Verificación', badge(facts.passed ? 'passed = true' : 'passed = false', facts.passed ? 'good' : 'critical')]
      ]));
    }
  }

  function renderAll() {
    renderStatus(null);
    renderVerdict();
    renderTimeline();
    renderSignals();
    renderMeta();
    renderUsage();
    renderIntervention();
    renderVerification();
    renderEvidence();
    renderLogEmpty();
    refreshControls();
  }

  /* --------------------------------------------------------------- Arranque */

  function startTask() {
    if (starting) return;
    starting = true;
    resetSession();
    setError('', '');
    refreshControls();
    renderStatus('Creando la tarea supervisada: esperando la respuesta del servidor…');
    if (els.status) els.status.focus();

    request('POST', BASE + '/tasks', {}).then(function (result) {
      starting = false;
      refreshControls();

      if (result.networkError) {
        renderStatus(null);
        setConnection('error', 'La API de continuidad no responde');
        setError('La API de continuidad no responde',
          'POST ' + BASE + '/tasks no llegó a completarse (' + result.networkError + '). No se ha creado ninguna sesión y el registro se queda vacío a propósito: el panel no escribe texto de worker por su cuenta.');
        return;
      }
      if (result.status === 401 || result.status === 403) {
        renderStatus(null);
        revealKey(true);
        setError('La escritura exige autorización (HTTP ' + result.status + ')',
          'POST ' + BASE + '/tasks respondió HTTP ' + result.status + '.' + apiMessage(result) +
          ' El core protege la creación de tareas: escribe la llave de operador en el campo de esta sección y vuelve a intentarlo. La llave sólo viaja en la cabecera X-Continuity-Key de esta pestaña y no se guarda.');
        return;
      }
      if (result.status === 404) {
        renderStatus(null);
        setError('El contrato de continuidad no está implementado (HTTP 404)',
          'POST ' + BASE + '/tasks respondió HTTP 404: este build del servidor no expone estas rutas. No se muestra ninguna demo en su lugar.');
        return;
      }
      if (result.status === 503) {
        renderStatus(null);
        setError('La tarea no puede ejecutarse ahora (HTTP 503)',
          'POST ' + BASE + '/tasks respondió HTTP 503.' + apiMessage(result) +
          ' El panel no reintenta solo ni simula la tarea.');
        return;
      }
      if (result.status === 429) {
        renderStatus(null);
        noteBackoff('la creación de la tarea');
        return;
      }
      if (!result.ok) {
        renderStatus(null);
        setError('La API rechazó el inicio (HTTP ' + result.status + ')',
          'POST ' + BASE + '/tasks respondió HTTP ' + result.status + ' ' + result.statusText + '.' + apiMessage(result));
        return;
      }
      if (result.invalidJson || field(result.data, 'session') === undefined) {
        renderStatus(null);
        setError('Respuesta sin { session }',
          'POST ' + BASE + '/tasks respondió HTTP ' + result.status + ' sin un objeto { session } interpretable. No se muestra ninguna tarea.');
        return;
      }
      var fresh = field(result.data, 'session');
      if (!isObj(fresh)) {
        renderStatus(null);
        setError('Respuesta con forma inesperada',
          'El campo session de la respuesta no es un objeto. El panel no lo interpreta ni lo completa.');
        return;
      }
      acceptSession(fresh);
    });
  }

  /* Sin ?session en la URL: muestra la última ejecución de esta instancia, si la
     hay, en modo sólo lectura. No inicia nada ni envía la llave de operador. */
  function loadLatestSession() {
    fetch(BASE + '/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (payload) {
        var latest = payload === null ? null : textOr(field(payload, 'latestSessionId'), null);
        if (latest !== null && /^cs_[A-Za-z0-9_-]{1,90}$/.test(latest)) {
          session = { id: latest };
          renderAll();
          loadSession(false);
        }
      })
      .catch(function () {
        /* sin sesión previa: el panel queda en su estado vacío declarado */
      });
  }

  function loadSession(auto) {
    if (polling || !session) return;
    var id = textOr(field(session, 'id'), null);
    if (id === null) return;
    var path = BASE + '/tasks/' + encodeURIComponent(id);
    polling = true;
    refreshControls();

    request('GET', path, undefined).then(function (result) {
      polling = false;

      if (result.networkError) {
        pollFailures += 1;
        if (auto && pollFailures <= MAX_POLL_FAILURES) {
          setError('Sondeo interrumpido (' + pollFailures + '/' + MAX_POLL_FAILURES + ')',
            'GET ' + path + ' no respondió (' + result.networkError + '). El registro conserva sólo los eventos ya recibidos: no se añade texto de relleno. Se reintenta en ' + Math.max(POLL_MS, backoffMs) / 1000 + ' s.');
          refreshControls();
          schedulePoll();
          return;
        }
        setConnection('error', 'La API de continuidad dejó de responder');
        setError('La API de continuidad dejó de responder',
          'GET ' + path + ' no respondió (' + result.networkError + '). Se detiene el sondeo automático; el registro no se toca y no se inventa el resto del worker. Usa «Actualizar estado» para reintentar.');
        refreshControls();
        return;
      }
      pollFailures = 0;

      if (!result.ok) {
        if (result.status === 404) {
          setError('La sesión ya no existe (HTTP 404)',
            'GET ' + path + ' respondió HTTP 404. El panel mantiene en pantalla lo último recibido, marcado como no actual, y no completa la sesión.');
          renderStatus(null);
          refreshControls();
          return;
        }
        if (result.status === 429) {
          noteBackoff('el sondeo de la sesión');
          refreshControls();
          schedulePoll();
          return;
        }
        setError('Consulta rechazada (HTTP ' + result.status + ')',
          'GET ' + path + ' respondió HTTP ' + result.status + ' ' + result.statusText + '.' + apiMessage(result));
        refreshControls();
        return;
      }
      if (result.invalidJson) {
        setError('Respuesta no interpretable',
          'GET ' + path + ' devolvió un cuerpo que no es un objeto JSON. El registro no se modifica.');
        refreshControls();
        return;
      }
      var fresh = field(result.data, 'session');
      if (!isObj(fresh)) {
        setError('Respuesta sin { session }',
          'GET ' + path + ' respondió HTTP ' + result.status + ' sin { session }. El registro no se modifica.');
        refreshControls();
        return;
      }
      backoffMs = 0;
      setError('', '');
      renderStatus(null);
      acceptSession(fresh);
    });
  }

  function checkStatus() {
    request('GET', BASE + '/status', undefined).then(function (result) {
      statusKnown = true;
      if (result.networkError) {
        renderStatus(null);
        refreshControls();
        setConnection('error', 'La API de continuidad no está disponible');
        setError('La API de continuidad no está disponible',
          'GET ' + BASE + '/status no respondió (' + result.networkError + '). El botón sigue disponible, pero si el servidor no expone estas rutas la creación fallará y el error se mostrará sin sustituirse por datos de ejemplo.');
        return;
      }
      if (!result.ok) {
        renderStatus(null);
        refreshControls();
        var hint = result.status === 404 ? ' Este build del servidor no expone /api/continuity (404).' : '';
        setConnection('error', 'Estado de continuidad no disponible (HTTP ' + result.status + ')');
        setError('Estado de continuidad no disponible (HTTP ' + result.status + ')',
          'GET ' + BASE + '/status respondió HTTP ' + result.status + ' ' + result.statusText + '.' + hint + apiMessage(result));
        return;
      }
      statusBody = result.data;
      var flagValue = field(result.data, 'enabled');
      enabled = typeof flagValue === 'boolean' ? flagValue : null;
      statusReason = textOr(field(result.data, 'reason'), null);
      if (enabled === false) {
        setConnection('stale', 'Continuidad deshabilitada en el servidor');
        setError('Continuidad deshabilitada en el servidor',
          'GET ' + BASE + '/status informa enabled:false' + (statusReason ? ': ' + statusReason : '') +
          '. El botón no crea sesiones mientras siga así.');
      } else {
        setConnection('online', 'API de continuidad disponible — ' + BASE);
        setError('', '');
      }
      renderStatus(null);
      refreshControls();
    });
  }

  /* -------------------------------------------------------------------- Init */

  function init() {
    els = {
      start: byId('lg-start'),
      refresh: byId('lg-refresh'),
      keyToggle: byId('lg-key-toggle'),
      keyWrap: byId('lg-key-wrap'),
      key: byId('lg-key'),
      errors: byId('lg-errors'),
      status: byId('lg-status'),
      verdict: byId('lg-verdict'),
      timeline: byId('lg-timeline'),
      signals: byId('lg-signals'),
      meta: byId('lg-meta'),
      usage: byId('lg-usage'),
      intervention: byId('lg-intervention'),
      verification: byId('lg-verification'),
      evidence: byId('lg-evidence'),
      log: byId('lg-log'),
      logEmpty: byId('lg-log-empty')
    };
    /* Si la sección no está en el documento, este bloque no toca nada. */
    if (!els.start || !els.status || !els.log) return;

    els.start.addEventListener('click', startTask);
    if (els.refresh) {
      els.refresh.addEventListener('click', function () {
        pollFailures = 0;
        loadSession(false);
      });
    }
    if (els.keyToggle) {
      els.keyToggle.addEventListener('click', function () {
        var expanded = els.keyToggle.getAttribute('aria-expanded') === 'true';
        revealKey(!expanded);
      });
    }
    /* La llave no se guarda en storage ni en cookies: no se añade aquí ningún
       listener de persistencia, y el campo se vacía al cerrarse. */

    renderAll();
    renderStatus('Consultando si el servidor tiene la continuidad habilitada…');
    checkStatus();
    var requestedSession = new URLSearchParams(window.location.search).get('session');
    if (requestedSession && /^cs_[A-Za-z0-9_-]{1,90}$/.test(requestedSession)) {
      session = { id: requestedSession };
      loadSession(false);
    } else {
      loadLatestSession();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
