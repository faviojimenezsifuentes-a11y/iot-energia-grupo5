# Seguridad del sistema

Este documento describe cómo el sistema cumple el requerimiento **RNF06 — Seguridad**: *la comunicación y los comandos de control deberán contar con mecanismos que eviten accesos no autorizados*. Las medidas se alinean con las capacidades base de NIST IR 8259A para dispositivos IoT.

## Riesgos considerados

| Riesgo | Ejemplo | Medida |
|---|---|---|
| Espionaje del tráfico | Alguien en la misma red lee las mediciones | Cifrado **TLS** en todo el recorrido (MQTT 8883 en el ESP32, WSS 8084 en el dashboard) |
| Broker falso | Un atacante suplanta al servidor para robar la contraseña | El ESP32 **verifica el certificado** del broker contra raíces de confianza fijas (`certificado.h`) |
| Acceso no autorizado | Un tercero apaga la luz o lee los datos | Broker **privado** con **usuario y contraseña**; credencial distinta para la placa y para el dashboard |
| Filtración de contraseñas | Contraseñas publicadas en GitHub | Credenciales solo en `secrets.h` (en `.gitignore`); la CI falla si `secrets.h` aparece en el repo; el dashboard **no guarda** la contraseña |
| Comandos maliciosos o erróneos | Mensajes largos, caracteres extraños, límites absurdos | **Lista blanca** de comandos, largo máximo de 24 caracteres, rango de límite 0,01–50 W, anti-spam de 300 ms y respuesta ACK |
| Inyección en el dashboard (XSS) | Un mensaje con código HTML/JS | Los datos se validan por tipo y se muestran como texto; **Content-Security-Policy** estricta: solo scripts propios y conexiones WSS solo al dominio del broker |
| Dependencias de terceros comprometidas | Un CDN modificado | La librería MQTT.js se sirve **desde el propio repo** (sin CDN) |
| Sesión olvidada abierta | Alguien usa la laptop de la demo | **Cierre de sesión automático** a los 15 min de inactividad y botón *Cerrar sesión* |
| Pérdida de conexión | Se cae el Wi-Fi o el broker | La **automatización es local**: el ESP32 sigue cortando el sobreconsumo sin internet; reconexión automática no bloqueante |
| Falla del sensor | El INA219 deja de responder | **Failsafe**: en modo automático se corta la carga y se notifica |
| Programa colgado | Error inesperado en el firmware | **Watchdog** de 30 s que reinicia la placa |
| Riesgo eléctrico | Manipulación de 220 V | Solo cargas de **baja tensión (5 V)**; la red de 220 V no entra al protoboard |

## Buenas prácticas para el equipo
- Usar contraseñas largas y distintas para `esp32-grupo5` y `dashboard-grupo5`.
- Si una contraseña se filtra: cambiarla en el panel del broker (EMQX: Access Control → Authentication) y en `secrets.h`.
- Configurar en el broker reglas de autorización (ACL) para que cada usuario solo acceda a `grupo5iot/vivienda/energia/#`.
- Mantener activados en GitHub **Secret scanning** y **Push protection** (Settings → Code security).
- No compartir capturas del Monitor Serie o de `secrets.h` que muestren credenciales.

## Limitaciones conocidas
- Si no se configuran reglas ACL en el broker, ambos usuarios pueden publicar y suscribirse en todos los temas de la cuenta.
- El dashboard es una página estática: la autenticación la realiza el broker, no un servidor propio.
