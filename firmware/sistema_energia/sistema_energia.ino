/*
  =====================================================================
   Sistema IoT de monitoreo y control del consumo energético
   IoT Grupo 5 — ESP32 + INA219 + DHT22 + Relé          Firmware v2.0
  =====================================================================
   Funciones
   - Mide voltaje, corriente y potencia (INA219) y temperatura/humedad (DHT22)
   - Publica las mediciones cada 2 s por MQTT sobre TLS a un broker privado (EMQX Cloud)
   - Detecta sobreconsumo y, en modo AUTO, corta la carga con el relé
   - Recibe comandos del dashboard y responde con un acuse (ACK)

   Seguridad
   - Cifrado TLS y verificación del certificado del broker (certificado.h)
   - Usuario y contraseña MQTT propios del ESP32 (secrets.h, fuera de GitHub)
   - Lista blanca de comandos, validación de rangos y anti-spam
   - La automatización funciona aunque se caiga el Wi-Fi o el broker
   - Failsafe: si el sensor eléctrico falla en modo AUTO, se corta la carga
   - Watchdog: si el programa se cuelga, el ESP32 se reinicia solo

   Librerías (Arduino IDE > Library Manager)
   - DHT sensor library (Adafruit) + Adafruit Unified Sensor
   - Adafruit INA219
   - PubSubClient (Nick O'Leary)
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <time.h>
#include <esp_task_wdt.h>
#include <PubSubClient.h>
#include <Adafruit_INA219.h>
#include <DHT.h>

#include "config.h"
#include "certificado.h"
#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "Falta secrets.h: copien secrets.example.h como secrets.h y completen sus datos"
#endif

DHT dht(DHT_PIN, DHT_TYPE);
Adafruit_INA219 ina219;
WiFiClientSecure clienteSeguro;
PubSubClient mqtt(clienteSeguro);

// ---------- Estado ----------
bool  cargaActivada  = false;
bool  modoAuto       = true;
bool  alerta         = false;
const char* motivoAlerta = "";
bool  inaOk          = false;
float limitePotencia = LIMITE_INICIAL_W;
float energiaWh      = 0.0f;

unsigned long ultimaLectura       = 0;
unsigned long ultimoCalculoEnergia = 0;
unsigned long ultimoIntentoWifi   = 0;
unsigned long ultimoIntentoMqtt   = 0;
unsigned long ultimoComando       = 0;
bool forzarPublicacion = true;

// ---------- Arreglos ----------
// Lista blanca de comandos sin parámetros que acepta el ESP32
const char* const COMANDOS_PERMITIDOS[] = { "ON", "OFF", "AUTO", "MANUAL", "RESET_ENERGIA" };
const int N_COMANDOS = sizeof(COMANDOS_PERMITIDOS) / sizeof(COMANDOS_PERMITIDOS[0]);

// Últimas lecturas de potencia: el promedio móvil evita que un pico aislado
// (ruido al conmutar el relé) dispare una alerta falsa.
float muestrasPotencia[N_MUESTRAS] = { 0 };
int   indiceMuestra = 0;

float promedioPotencia(float nueva) {
  muestrasPotencia[indiceMuestra] = nueva;
  indiceMuestra = (indiceMuestra + 1) % N_MUESTRAS;
  float suma = 0;
  for (int i = 0; i < N_MUESTRAS; i++) suma += muestrasPotencia[i];
  return suma / N_MUESTRAS;
}

void reiniciarPromedio() {
  for (int i = 0; i < N_MUESTRAS; i++) muestrasPotencia[i] = 0;
  indiceMuestra = 0;
}

bool esComandoPermitido(const char* cmd) {
  if (strncmp(cmd, "LIMITE:", 7) == 0) return true;
  for (int i = 0; i < N_COMANDOS; i++) {
    if (strcmp(cmd, COMANDOS_PERMITIDOS[i]) == 0) return true;
  }
  return false;
}

// =====================================================================
//  Actuadores
// =====================================================================
// El relé se alimenta con 5 V y el ESP32 trabaja a 3,3 V: un HIGH de 3,3 V no
// alcanza para soltarlo. Para soltarlo se deja el pin como entrada ("suelto")
// y para activarlo se pone en LOW (módulo activo en bajo).
void controlarCarga(bool encender) {
  cargaActivada = encender;
  bool releActivo = LUZ_EN_NC ? !encender : encender;
  if (releActivo) {
    pinMode(RELE_PIN, OUTPUT);
    digitalWrite(RELE_PIN, LOW);
  } else {
    pinMode(RELE_PIN, INPUT);
  }
  Serial.printf("[RELE] Carga %s\n", encender ? "ENCENDIDA" : "APAGADA");
  forzarPublicacion = true;
}

void setAlerta(bool estado, const char* motivo) {
  alerta = estado;
  motivoAlerta = estado ? motivo : "";
  digitalWrite(LED_ALERTA, estado ? HIGH : LOW);
}

unsigned long epochActual() {
  time_t t = time(nullptr);
  return (t > 1700000000) ? (unsigned long)t : 0;   // 0 = hora aún no sincronizada
}

// =====================================================================
//  Comandos (dashboard -> ESP32)
// =====================================================================
void responder(const char* cmd, bool ok, const char* msg) {
  char json[160];
  snprintf(json, sizeof(json), "{\"cmd\":\"%s\",\"ok\":%s,\"msg\":\"%s\",\"ts\":%lu}",
           cmd, ok ? "true" : "false", msg, epochActual());
  mqtt.publish(TOPIC_ACK, json);
  Serial.printf("[CMD] %s -> %s (%s)\n", cmd, ok ? "OK" : "RECHAZADO", msg);
}

bool caracteresValidos(const char* s) {
  for (; *s; s++) {
    char c = *s;
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == ':' || c == '.')) return false;
  }
  return true;
}

void alRecibirMensaje(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, TOPIC_CONTROL) != 0) return;

  // 1) Tamaño máximo
  if (length == 0 || length > CMD_MAX_LEN) { responder("INVALIDO", false, "comando vacio o demasiado largo"); return; }

  // 2) Copia segura y normalización
  char cmd[CMD_MAX_LEN + 1];
  for (unsigned int i = 0; i < length; i++) cmd[i] = toupper((char)payload[i]);
  cmd[length] = '\0';
  if (!caracteresValidos(cmd)) { responder("INVALIDO", false, "caracteres no permitidos"); return; }

  // 3) Anti-spam
  if (millis() - ultimoComando < CMD_MIN_INTERVALO_MS) { responder(cmd, false, "demasiados comandos seguidos"); return; }
  ultimoComando = millis();

  // 4) Lista blanca (arreglo COMANDOS_PERMITIDOS)
  if (!esComandoPermitido(cmd)) { responder("DESCONOCIDO", false, "comando no permitido"); return; }

  if (strcmp(cmd, "ON") == 0) {
    if (modoAuto && !inaOk) { responder(cmd, false, "sin sensor electrico: use modo MANUAL"); return; }
    setAlerta(false, "");
    reiniciarPromedio();
    controlarCarga(true);
    responder(cmd, true, "carga encendida");
  } else if (strcmp(cmd, "OFF") == 0) {
    controlarCarga(false);
    responder(cmd, true, "carga apagada");
  } else if (strcmp(cmd, "AUTO") == 0) {
    modoAuto = true;
    responder(cmd, true, "modo automatico");
  } else if (strcmp(cmd, "MANUAL") == 0) {
    modoAuto = false;
    responder(cmd, true, "modo manual");
  } else if (strncmp(cmd, "LIMITE:", 7) == 0) {
    float nuevo = atof(cmd + 7);
    if (!(nuevo >= LIMITE_MIN_W && nuevo <= LIMITE_MAX_W)) { responder("LIMITE", false, "fuera de rango (0.01 - 50 W)"); return; }
    limitePotencia = nuevo;
    responder("LIMITE", true, "limite actualizado");
  } else if (strcmp(cmd, "RESET_ENERGIA") == 0) {
    energiaWh = 0;
    responder(cmd, true, "energia reiniciada");
  } else {
    responder("DESCONOCIDO", false, "comando no permitido");
    return;
  }
  forzarPublicacion = true;
}

// =====================================================================
//  Conectividad (no bloqueante: la automatización sigue sin internet)
// =====================================================================
void manejarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - ultimoIntentoWifi < WIFI_REINTENTO_MS && ultimoIntentoWifi != 0) return;
  ultimoIntentoWifi = millis();
  Serial.println("[WIFI] Conectando...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void manejarMQTT() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - ultimoIntentoMqtt < MQTT_REINTENTO_MS && ultimoIntentoMqtt != 0) return;
  ultimoIntentoMqtt = millis();

  char id[40];
  snprintf(id, sizeof(id), "esp32-g5-%08lx", (unsigned long)(ESP.getEfuseMac() & 0xFFFFFFFF));
  Serial.printf("[MQTT] Conectando a %s:%d (TLS)... ", MQTT_HOST, MQTT_PORT);

  // Last Will: si el ESP32 se desconecta, el broker publica "offline"
  if (mqtt.connect(id, MQTT_USER, MQTT_PASSWORD, TOPIC_ESTADO, 1, true, "offline")) {
    Serial.println("OK");
    mqtt.publish(TOPIC_ESTADO, "online", true);
    mqtt.subscribe(TOPIC_CONTROL, 1);
    forzarPublicacion = true;
  } else {
    // -2: sin red/TLS  4: usuario o clave incorrectos  5: no autorizado
    Serial.printf("fallo (rc=%d)\n", mqtt.state());
  }
}

// =====================================================================
//  Setup
// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n=== Sistema IoT Grupo 5 - firmware %s ===\n", FIRMWARE_VERSION);

  pinMode(LED_ALERTA, OUTPUT);
  controlarCarga(false);              // estado inicial seguro
  setAlerta(false, "");

  // Watchdog
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdt = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);

  dht.begin();
  Wire.begin(I2C_SDA, I2C_SCL);
  inaOk = ina219.begin();
  if (inaOk) ina219.setCalibration_32V_1A();
  else Serial.println("[INA219] No detectado: revisar VCC, GND, SDA(21), SCL(22)");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  manejarWiFi();
  configTime(ZONA_HORARIA_S, 0, "pool.ntp.org", "time.google.com");

  clienteSeguro.setCACert(ROOT_CA);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(alRecibirMensaje);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);

  ultimoCalculoEnergia = millis();
}

// =====================================================================
//  Loop
// =====================================================================
void loop() {
  esp_task_wdt_reset();
  manejarWiFi();
  manejarMQTT();
  mqtt.loop();

  if (!forzarPublicacion && millis() - ultimaLectura < INTERVALO_MS) return;
  forzarPublicacion = false;
  ultimaLectura = millis();

  // ---------- DHT22 (reintento + último valor válido durante 30 s) ----------
  static float ultTemp = NAN, ultHum = NAN;
  static unsigned long ultDhtOk = 0;
  float temperatura = dht.readTemperature();
  float humedad     = dht.readHumidity();
  if (isnan(temperatura) || isnan(humedad)) {
    delay(100);
    temperatura = dht.readTemperature(false, true);
    humedad     = dht.readHumidity(true);
  }
  if (!isnan(temperatura) && !isnan(humedad)) {
    ultTemp = temperatura; ultHum = humedad; ultDhtOk = millis();
  } else {
    Serial.println("[DHT22] Error de lectura (revisar DATA en D4, VCC en 3V3 y GND)");
    if (ultDhtOk != 0 && millis() - ultDhtOk < 30000) { temperatura = ultTemp; humedad = ultHum; }
  }
  bool dhtOk = !(isnan(temperatura) || isnan(humedad));

  // ---------- INA219 ----------
  float voltaje = 0, corriente = 0, potencia = 0;
  if (inaOk) {
    voltaje   = ina219.getBusVoltage_V() + ina219.getShuntVoltage_mV() / 1000.0f;
    corriente = ina219.getCurrent_mA() / 1000.0f;
    if (corriente < 0.0005f) corriente = 0;          // ruido sin carga
    potencia  = voltaje * corriente;                 // P = V x I
  }
  bool electricoOk = inaOk && isfinite(voltaje) && isfinite(corriente) && isfinite(potencia);
  float potenciaProm = electricoOk ? promedioPotencia(potencia) : 0;

  unsigned long ahora = millis();
  if (electricoOk) energiaWh += potencia * ((ahora - ultimoCalculoEnergia) / 3600000.0f);
  ultimoCalculoEnergia = ahora;

  // ---------- Automatización y failsafe ----------
  if (electricoOk && potenciaProm > limitePotencia) {
    if (!alerta) Serial.printf("[ALERTA] Sobreconsumo: promedio %.3f W > %.3f W\n", potenciaProm, limitePotencia);
    setAlerta(true, "sobreconsumo");
    if (modoAuto && cargaActivada) controlarCarga(false);
  } else if (modoAuto && cargaActivada && !electricoOk) {
    Serial.println("[FAILSAFE] Sin lectura electrica valida: se corta la carga");
    setAlerta(true, "sensor");
    controlarCarga(false);
  } else if (!modoAuto) {
    setAlerta(false, "");
  }
  // En modo AUTO la alerta queda activa hasta que el usuario reactive la carga (ON)

  // ---------- Monitor serie ----------
  Serial.printf("T=%.1fC H=%.1f%% | V=%.2fV I=%.3fA P=%.3fW E=%.4fWh | Carga=%s Modo=%s Alerta=%s | WiFi=%s MQTT=%s\n",
    temperatura, humedad, voltaje, corriente, potencia, energiaWh,
    cargaActivada ? "ON" : "OFF", modoAuto ? "AUTO" : "MANUAL", alerta ? motivoAlerta : "no",
    WiFi.status() == WL_CONNECTED ? "ok" : "no", mqtt.connected() ? "ok" : "no");

  // ---------- Publicación ----------
  if (!mqtt.connected()) return;

  char tempStr[12], humStr[12];
  if (dhtOk) { dtostrf(temperatura, 0, 2, tempStr); dtostrf(humedad, 0, 2, humStr); }
  else       { strcpy(tempStr, "null"); strcpy(humStr, "null"); }

  char json[480];
  snprintf(json, sizeof(json),
    "{\"temperatura\":%s,\"humedad\":%s,\"voltaje\":%.3f,\"corriente\":%.4f,"
    "\"potencia\":%.4f,\"potencia_prom\":%.4f,\"energia_wh\":%.5f,\"limite\":%.3f,\"carga_activa\":%s,"
    "\"modo\":\"%s\",\"alerta\":%s,\"alerta_motivo\":\"%s\",\"sensor_electrico\":%s,"
    "\"sensor_ambiental\":%s,\"rssi\":%d,\"uptime\":%lu,\"ts\":%lu,\"fw\":\"%s\"}",
    tempStr, humStr, voltaje, corriente, potencia, potenciaProm, energiaWh, limitePotencia,
    cargaActivada ? "true" : "false", modoAuto ? "AUTO" : "MANUAL",
    alerta ? "true" : "false", motivoAlerta, electricoOk ? "true" : "false",
    dhtOk ? "true" : "false", WiFi.RSSI(), millis() / 1000, epochActual(), FIRMWARE_VERSION);

  mqtt.publish(TOPIC_DATOS, json, true);   // retenido: el dashboard ve el último dato al entrar
}
