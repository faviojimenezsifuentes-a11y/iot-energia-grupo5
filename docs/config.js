// Configuración pública del dashboard (NO poner contraseñas aquí).
// brokerHost: dirección del broker privado.
//   EMQX Cloud Serverless -> "xxxx.ala.us-east-1.emqxsl.com"  (WSS puerto 8084)
//   HiveMQ Cloud          -> "xxxx.s1.eu.hivemq.cloud"        (WSS puerto 8884)
// El puerto se elige solo según el dominio.
window.APP_CONFIG = {
  brokerHost: "r10727a9.ala.us-east-1.emqxsl.com",
  brokerPath: "/mqtt",
  topicBase: "grupo5iot/vivienda/energia",
  inactividadMin: 15                      // cierre de sesión automático
};
