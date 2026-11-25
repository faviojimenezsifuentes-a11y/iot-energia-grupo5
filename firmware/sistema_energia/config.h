#pragma once
// =====================================================================
//  CONFIGURACIÓN DEL SISTEMA (sin datos secretos)
// =====================================================================

#define FIRMWARE_VERSION "2.1.0"

// ---------- Pines ----------
#define DHT_PIN      4      // DATA del DHT22
#define DHT_TYPE     DHT22
#define I2C_SDA      21     // INA219
#define I2C_SCL      22     // INA219
#define RELE_PIN     19     // IN del módulo relé
#define LED_ALERTA   18     // LED de alerta (con resistencia de 220 ohm)

// Si la luz está conectada al borne NC del relé, poner true.
// Lo recomendado es usar el borne NO y dejar false.
#define LUZ_EN_NC    true

// ---------- Temas MQTT ----------
#define TOPIC_BASE     "grupo5iot/vivienda/energia"
#define TOPIC_DATOS    TOPIC_BASE "/datos"     // ESP32 -> dashboard (mediciones)
#define TOPIC_CONTROL  TOPIC_BASE "/control"   // dashboard -> ESP32 (comandos)
#define TOPIC_ACK      TOPIC_BASE "/ack"       // ESP32 -> dashboard (respuesta a comandos)
#define TOPIC_ESTADO   TOPIC_BASE "/estado"    // online / offline (Last Will)

// ---------- Parámetros ----------
#define LIMITE_INICIAL_W     0.30f   // límite de potencia al arrancar
#define LIMITE_MIN_W         0.01f   // rango permitido para cambios desde el dashboard
#define LIMITE_MAX_W         50.0f
#define INTERVALO_MS         2000    // lectura y publicación
#define N_MUESTRAS           3       // tamaño del promedio móvil de potencia (3 x 2 s)
#define CMD_MIN_INTERVALO_MS 300     // anti-spam: tiempo mínimo entre comandos
#define CMD_MAX_LEN          24      // largo máximo aceptado de un comando
#define WIFI_REINTENTO_MS    10000
#define MQTT_REINTENTO_MS    5000
#define WDT_TIMEOUT_S        30      // watchdog: reinicia si el programa se cuelga
#define ZONA_HORARIA_S       (-5 * 3600)  // Lima, UTC-5
