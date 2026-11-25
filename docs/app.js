/* Dashboard IoT Grupo 5 — monitoreo y control del consumo energético
   Seguridad:
   - Conexión MQTT cifrada (WSS/TLS) a un broker privado (EMQX Cloud o HiveMQ Cloud) con usuario y contraseña
   - La contraseña solo vive en memoria; nunca se guarda en el navegador
   - Cierre de sesión automático por inactividad
   - Todo dato recibido se valida y se muestra como texto (sin innerHTML con datos externos)
   - CSP estricta en index.html: solo scripts propios y conexiones WSS a *.emqxsl.com / *.hivemq.cloud */
(() => {
  "use strict";

  const CFG = Object.assign({ brokerHost: "", brokerPath: "/mqtt",
    topicBase: "grupo5iot/vivienda/energia", inactividadMin: 15 }, window.APP_CONFIG || {});
  const T = {
    datos: CFG.topicBase + "/datos", control: CFG.topicBase + "/control",
    ack: CFG.topicBase + "/ack", estado: CFG.topicBase + "/estado"
  };
  const MAX_PUNTOS = 90;        // ~3 min en las gráficas
  const MAX_HIST = 5000;        // límite de lecturas guardadas para el CSV

  const $ = (id) => document.getElementById(id);
  let client = null, ultimo = null, ultimoVisto = 0, alertaPrev = false, alertas = 0, alertaTempPrev = false, alertasTemp = 0;
  let hist = [], timerInactividad = null, timerToast = null;

  // ---------------- Utilidades ----------------
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const fmt = (v, d, u) => (v === null || v === undefined ? "--" : v.toFixed(d) + " " + u);
  const hora = (d = new Date()) => d.toLocaleTimeString("es-PE", { hour12: false });

  function log(texto, tipo) {
    const li = document.createElement("li");
    if (tipo) li.className = tipo;
    const t = document.createElement("time"); t.textContent = hora();
    const s = document.createElement("span"); s.textContent = texto;
    li.append(t, s);
    $("log").prepend(li);
    while ($("log").children.length > 150) $("log").lastChild.remove();
  }

  function toast(texto, mal) {
    const el = $("toast");
    el.textContent = texto;
    el.className = "toast" + (mal ? " mal" : "");
    el.hidden = false;
    clearTimeout(timerToast);
    timerToast = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function guardarPreferencias(host, user, recordar) {
    try {
      if (recordar) localStorage.setItem("g5_login", JSON.stringify({ host, user }));
      else localStorage.removeItem("g5_login");
    } catch (e) { /* almacenamiento no disponible */ }
  }
  function leerPreferencias() {
    try { return JSON.parse(localStorage.getItem("g5_login") || "null"); } catch (e) { return null; }
  }

  // ---------------- Login ----------------
  const pref = leerPreferencias();
  $("inHost").value = (pref && pref.host) || CFG.brokerHost || "";
  $("inUser").value = (pref && pref.user) || "";
  $("inRecordar").checked = !!pref;

  // Solo brokers privados con TLS permitidos (coincide con la CSP de index.html)
  const BROKERS = [
    { dominio: /^[a-z0-9-]+(\.[a-z0-9-]+)*\.emqxsl\.com$/i, puerto: 8084 },
    { dominio: /^[a-z0-9-]+(\.[a-z0-9-]+)*\.hivemq\.cloud$/i, puerto: 8884 }
  ];
  const brokerDe = (host) => BROKERS.find((b) => b.dominio.test(host));

  $("formLogin").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const host = $("inHost").value.trim().replace(/^wss?:\/\//, "").replace(/[:/].*$/, "");
    const user = $("inUser").value.trim();
    const pass = $("inPass").value;
    $("loginError").textContent = "";
    const broker = brokerDe(host);
    if (!broker) { $("loginError").textContent = "Dirección no válida: debe terminar en .emqxsl.com o .hivemq.cloud."; return; }
    if (!user || !pass) { $("loginError").textContent = "Ingresen usuario y contraseña."; return; }
    if (typeof mqtt === "undefined") { $("loginError").textContent = "No se pudo cargar la librería MQTT."; return; }
    conectar(host, broker.puerto, user, pass);
  });

  function conectar(host, puerto, user, pass) {
    $("btnLogin").disabled = true;
    $("btnLogin").textContent = "Conectando…";
    let entro = false;

    client = mqtt.connect(`wss://${host}:${puerto}${CFG.brokerPath}`, {
      username: user,
      password: pass,
      clientId: "dash-g5-" + crypto.getRandomValues(new Uint32Array(1))[0].toString(16),
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 0,          // durante el login no se reintenta
      protocolVersion: 4
    });

    client.on("connect", () => {
      if (!entro) {
        entro = true;
        $("inPass").value = "";
        guardarPreferencias(host, user, $("inRecordar").checked);
        client.options.reconnectPeriod = 5000;   // ya autenticados: reconectar solo
        mostrarApp();
        log("Sesión iniciada como " + user + " (conexión cifrada)", "ok");
      } else {
        log("Reconectado al broker", "ok");
      }
      $("ptBroker").className = "punto on"; $("txtBroker").textContent = "Broker";
      client.subscribe([T.datos, T.estado, T.ack], { qos: 1 });
    });

    client.on("error", (err) => {
      if (!entro) {
        const auth = err && (err.code === 4 || err.code === 5 || /auth|password/i.test(err.message || ""));
        $("loginError").textContent = auth ? "Usuario o contraseña incorrectos." : "No se pudo conectar al broker. Revisen la dirección del broker y su internet.";
        restaurarBotonLogin();
        client.end(true);
      }
    });

    client.on("close", () => {
      if (!entro) {
        if (!$("loginError").textContent) {
          $("loginError").textContent = "No se pudo abrir la conexión segura (puerto 8084). " +
            "La red puede estar bloqueándolo: prueben con los datos del celular o en Chrome.";
        }
        restaurarBotonLogin();
        if (client) client.end(true);
        return;
      }
      $("ptBroker").className = "punto off"; $("txtBroker").textContent = "Sin broker";
    });

    client.on("message", (topic, mensaje) => {
      const txt = mensaje.toString();
      if (txt.length > 2000) return;                  // descartar mensajes anómalos
      if (topic === T.estado) {
        if (txt === "online" || txt === "offline") log("ESP32 " + txt, txt === "online" ? "ok" : "mal");
        return;
      }
      let d;
      try { d = JSON.parse(txt); } catch (e) { return; }
      if (!d || typeof d !== "object") return;
      if (topic === T.datos) onDatos(d);
      else if (topic === T.ack) onAck(d);
    });
  }

  function restaurarBotonLogin() {
    $("btnLogin").disabled = false;
    $("btnLogin").textContent = "Conectar de forma segura";
  }

  function mostrarApp() {
    $("vistaLogin").hidden = true;
    $("vistaApp").hidden = false;
    reiniciarInactividad();
    dibujar();
  }

  function cerrarSesion(motivo) {
    if (client) { client.end(true); client = null; }
    hist = []; ultimo = null; ultimoVisto = 0; alertas = 0; alertaPrev = false; alertasTemp = 0; alertaTempPrev = false;
    $("log").replaceChildren();
    $("vistaApp").hidden = true;
    $("vistaLogin").hidden = false;
    restaurarBotonLogin();
    $("loginError").textContent = motivo || "";
    clearTimeout(timerInactividad);
  }
  $("btnSalir").addEventListener("click", () => cerrarSesion(""));

  function reiniciarInactividad() {
    clearTimeout(timerInactividad);
    timerInactividad = setTimeout(() => cerrarSesion("Sesión cerrada por inactividad."), CFG.inactividadMin * 60000);
  }
  ["click", "keydown", "pointermove", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, () => { if (!$("vistaApp").hidden) reiniciarInactividad(); }, { passive: true }));

  // ---------------- Datos ----------------
  function onDatos(raw) {
    const d = {
      temperatura: num(raw.temperatura), humedad: num(raw.humedad),
      voltaje: num(raw.voltaje), corriente: num(raw.corriente), potencia: num(raw.potencia),
      energia_wh: num(raw.energia_wh), limite: num(raw.limite), rssi: num(raw.rssi),
      carga_activa: raw.carga_activa === true, alerta: raw.alerta === true,
      limite_temp: num(raw.limite_temp), alerta_temp: raw.alerta_temp === true,
      modo: raw.modo === "MANUAL" ? "MANUAL" : "AUTO",
      alerta_motivo: raw.alerta_motivo === "sensor" ? "sensor" : "sobreconsumo",
      sensor_electrico: raw.sensor_electrico !== false,
      fw: typeof raw.fw === "string" ? raw.fw.slice(0, 12) : "--",
      hora: hora()
    };
    ultimo = d; ultimoVisto = Date.now();
    hist.push(d); if (hist.length > MAX_HIST) hist.shift();

    $("vPot").textContent = d.sensor_electrico ? fmt(d.potencia, 3, "W") : "sin sensor";
    $("vCor").textContent = d.corriente === null ? "--" : (d.corriente * 1000).toFixed(1) + " mA";
    $("vVol").textContent = fmt(d.voltaje, 2, "V");
    $("vEne").textContent = fmt(d.energia_wh, 4, "Wh");
    $("vTem").textContent = fmt(d.temperatura, 1, "°C");
    $("dTem").textContent = d.limite_temp !== null ? "límite " + d.limite_temp.toFixed(1) + " °C" : "";
    $("kTem").classList.toggle("calor", d.alerta_temp);
    if (document.activeElement !== $("iLimT") && d.limite_temp !== null) $("iLimT").value = d.limite_temp;

    // Alerta de temperatura
    const bT = $("bannerTemp");
    if (d.alerta_temp) {
      bT.textContent = "Temperatura alta: " + fmt(d.temperatura, 1, "°C") + " supera el límite de " + fmt(d.limite_temp, 1, "°C") + ".";
      bT.hidden = false;
    } else bT.hidden = true;
    if (d.alerta_temp && !alertaTempPrev) {
      alertasTemp++;
      log(`ALERTA: temperatura ${fmt(d.temperatura, 1, "°C")} > límite ${fmt(d.limite_temp, 1, "°C")}`, "mal");
      toast("Temperatura alta: " + fmt(d.temperatura, 1, "°C"), true);
    } else if (!d.alerta_temp && alertaTempPrev) {
      log("Temperatura normalizada", "ok");
    }
    alertaTempPrev = d.alerta_temp;
    $("vHum").textContent = fmt(d.humedad, 1, "%");
    const excede = d.potencia !== null && d.limite !== null && d.potencia > d.limite;
    $("kPot").classList.toggle("excede", excede);
    $("dPot").textContent = d.limite !== null ? "límite " + d.limite.toFixed(2) + " W" : "";

    // Maqueta y medidor
    $("svgCasa").classList.toggle("luz-on", d.carga_activa);
    $("txtCarga").textContent = d.carga_activa ? "Encendida" : "Apagada";
    if (d.limite) {
      const escala = d.limite * 1.5;
      $("medidorRelleno").style.width = Math.min(100, ((d.potencia || 0) / escala) * 100) + "%";
      $("medidorRelleno").classList.toggle("excede", excede);
      $("medidorLimite").style.left = (100 / 1.5) + "%";
      $("txtMedidor").textContent = (d.potencia || 0).toFixed(3) + " de " + d.limite.toFixed(2) + " W";
    }

    // Controles
    $("bAuto").classList.toggle("activo", d.modo === "AUTO");
    $("bManual").classList.toggle("activo", d.modo === "MANUAL");
    if (document.activeElement !== $("iLim") && d.limite !== null) $("iLim").value = d.limite;

    // Alerta
    const banner = $("bannerAlerta");
    if (d.alerta) {
      banner.textContent = d.alerta_motivo === "sensor"
        ? "Falla del sensor eléctrico: por seguridad se cortó la carga."
        : "Sobreconsumo detectado: la potencia superó el límite" + (d.modo === "AUTO" ? " y la luz se apagó automáticamente." : ".");
      banner.hidden = false;
    } else banner.hidden = true;
    if (d.alerta && !alertaPrev) {
      alertas++;
      log(d.alerta_motivo === "sensor" ? "FAILSAFE: falla del sensor, carga cortada"
        : `ALERTA: ${fmt(d.potencia, 3, "W")} > límite ${fmt(d.limite, 2, "W")}` + (d.modo === "AUTO" ? " · luz apagada" : ""), "mal");
    }
    alertaPrev = d.alerta;

    // Reporte
    const pots = hist.map((r) => r.potencia).filter((v) => v !== null);
    const tems = hist.map((r) => r.temperatura).filter((v) => v !== null);
    $("rN").textContent = hist.length;
    $("rProm").textContent = pots.length ? fmt(pots.reduce((a, b) => a + b, 0) / pots.length, 3, "W") : "--";
    $("rMax").textContent = pots.length ? fmt(Math.max(...pots), 3, "W") : "--";
    $("rAl").textContent = alertas;
    $("rAlT").textContent = alertasTemp;
    $("rTem").textContent = tems.length ? fmt(tems.reduce((a, b) => a + b, 0) / tems.length, 1, "°C") : "--";
    $("rRssi").textContent = d.rssi === null ? "--" : d.rssi + " dBm";
    $("rFw").textContent = d.fw;
    $("txtUltima").textContent = "Última lectura: " + d.hora;
    dibujar();
  }

  function onAck(a) {
    const cmd = typeof a.cmd === "string" ? a.cmd.slice(0, 24) : "?";
    const msg = typeof a.msg === "string" ? a.msg.slice(0, 80) : "";
    const ok = a.ok === true;
    toast((ok ? "ESP32: " : "Rechazado: ") + msg, !ok);
    log(`${ok ? "OK" : "RECHAZADO"} · ${cmd} · ${msg}`, ok ? "ok" : "mal");
  }

  // ---------------- Gráficas (SVG) ----------------
  function grafica(svg, series, limite) {
    const W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H) return;
    const p = { l: 46, r: 10, t: 12, b: 20 };
    const vals = series.flatMap((s) => s.data.filter((v) => v !== null));
    if (limite !== null && limite !== undefined) vals.push(limite);
    if (!vals.length) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" font-size="14">Esperando datos…</text>`;
      return;
    }
    const mn = Math.min(0, ...vals), mx = (Math.max(...vals) * 1.15) || 1;
    const dec = mx < 1 ? 3 : mx < 10 ? 2 : 1;
    const x = (i) => p.l + (i * (W - p.l - p.r)) / (MAX_PUNTOS - 1);
    const y = (v) => H - p.b - ((v - mn) / (mx - mn)) * (H - p.t - p.b);
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const v = mn + ((mx - mn) * k) / 4;
      g += `<line x1="${p.l}" x2="${W - p.r}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" opacity=".15"/>`;
      g += `<text x="${p.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="currentColor">${v.toFixed(dec)}</text>`;
    }
    if (limite !== null && limite !== undefined)
      g += `<line x1="${p.l}" x2="${W - p.r}" y1="${y(limite)}" y2="${y(limite)}" class="g-lim"/>`;
    for (const s of series) {
      const off = MAX_PUNTOS - s.data.length;
      const pts = s.data.map((v, i) => (v === null ? null : [x(i + off), y(v)])).filter(Boolean);
      if (!pts.length) continue;
      const linea = pts.map((q) => q.join(",")).join(" ");
      if (s.area) g += `<polygon points="${pts[0][0]},${y(mn)} ${linea} ${pts[pts.length - 1][0]},${y(mn)}" class="g-area ${s.cls}"/>`;
      g += `<polyline points="${linea}" class="g-linea ${s.cls}"/>`;
      const u = pts[pts.length - 1];
      g += `<circle cx="${u[0]}" cy="${u[1]}" r="4" class="g-punto ${s.cls}"/>`;
    }
    svg.innerHTML = g;   // solo números ya validados y texto fijo
  }

  function dibujar() {
    if ($("vistaApp").hidden) return;
    const h = hist.slice(-MAX_PUNTOS);
    grafica($("chPot"), [{ data: h.map((r) => r.potencia), cls: "s-pot", area: true }], ultimo ? ultimo.limite : null);
    grafica($("chAmb"), [{ data: h.map((r) => r.temperatura), cls: "s-tem" }, { data: h.map((r) => r.humedad), cls: "s-hum" }], ultimo ? ultimo.limite_temp : null);
  }
  const ro = new ResizeObserver(dibujar);
  ro.observe($("chPot")); ro.observe($("chAmb"));

  // ---------------- Comandos ----------------
  function enviar(cmd, descripcion) {
    if (!client || !client.connected) { toast("Sin conexión con el broker", true); return; }
    client.publish(T.control, cmd, { qos: 1 });
    log("Comando enviado: " + descripcion);
    document.querySelectorAll(".control button").forEach((b) => { b.disabled = true; });
    setTimeout(() => document.querySelectorAll(".control button").forEach((b) => { b.disabled = false; }), 400);
  }

  $("bOn").addEventListener("click", () => enviar("ON", "encender luz"));
  $("bOff").addEventListener("click", () => enviar("OFF", "apagar luz"));
  $("bAuto").addEventListener("click", () => enviar("AUTO", "modo automático"));
  $("bManual").addEventListener("click", () => enviar("MANUAL", "modo manual"));
  $("bReset").addEventListener("click", () => enviar("RESET_ENERGIA", "reiniciar energía"));
  $("bLim").addEventListener("click", () => {
    const v = parseFloat($("iLim").value);
    if (!(v >= 0.01 && v <= 50)) { $("limError").textContent = "Ingresen un valor entre 0.01 y 50 W."; return; }
    $("limError").textContent = "";
    enviar("LIMITE:" + v.toFixed(3), "límite " + v + " W");
  });
  $("iLim").addEventListener("input", () => { $("limError").textContent = ""; });
  $("bLimT").addEventListener("click", () => {
    const v = parseFloat($("iLimT").value);
    if (!(v >= 0 && v <= 60)) { $("limTError").textContent = "Ingresen un valor entre 0 y 60 °C."; return; }
    $("limTError").textContent = "";
    enviar("LIMTEMP:" + v.toFixed(1), "límite de temperatura " + v + " °C");
  });
  $("iLimT").addEventListener("input", () => { $("limTError").textContent = ""; });

  // ---------------- CSV ----------------
  $("bCsv").addEventListener("click", () => {
    if (!hist.length) { toast("Todavía no hay lecturas", true); return; }
    const cols = ["hora", "voltaje", "corriente", "potencia", "energia_wh", "limite", "temperatura", "humedad", "carga_activa", "modo", "alerta", "limite_temp", "alerta_temp"];
    const filas = hist.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? "" : String(r[c]))).join(","));
    const csv = [cols.join(",")].concat(filas).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "reporte_energia_" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------------- Estado del ESP32 ----------------
  setInterval(() => {
    if ($("vistaApp").hidden) return;
    const vivo = ultimoVisto && Date.now() - ultimoVisto < 10000;
    $("ptEsp").className = "punto " + (ultimoVisto ? (vivo ? "on" : "off") : "");
    $("txtEsp").textContent = ultimoVisto ? (vivo ? "ESP32 en línea" : "ESP32 sin respuesta") : "ESP32 sin datos";
  }, 2000);
})();
