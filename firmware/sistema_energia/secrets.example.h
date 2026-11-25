#pragma once
// =====================================================================
//  PLANTILLA DE CREDENCIALES
//  1. Copien este archivo y renómbrenlo a  secrets.h  (misma carpeta)
//  2. Completen sus datos reales en secrets.h
//  3. secrets.h está en .gitignore: NUNCA se sube a GitHub
// =====================================================================

// Red Wi-Fi (solo 2,4 GHz; en iPhone activar "Maximizar compatibilidad")
#define WIFI_SSID      "NOMBRE_DE_SU_RED"
#define WIFI_PASSWORD  "CLAVE_DE_SU_RED"

// Broker MQTT privado con TLS
//  EMQX Cloud Serverless: Overview -> Connection Information -> Address (termina en .emqxsl.com)
//  HiveMQ Cloud:          Overview -> Cluster URL (termina en .hivemq.cloud)
#define MQTT_HOST      "xxxxxxxx.ala.us-east-1.emqxsl.com"
#define MQTT_PORT      8883            // MQTT sobre TLS (igual en EMQX y HiveMQ)

// Credencial creada solo para el ESP32
// (EMQX: Access Control -> Authentication · HiveMQ: Access Management)
#define MQTT_USER      "esp32-grupo5"
#define MQTT_PASSWORD  "CONTRASEÑA_DEL_ESP32"
