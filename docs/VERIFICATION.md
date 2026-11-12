# Verificación y pendientes

Comprobaciones sobre esta copia anonimizada, 12 de noviembre de 2026:

| Comprobación | Resultado |
|---|---|
| Móvil `npm run typecheck` | PASS |
| Móvil `npm test -- --runInBand --silent` | 107 suites / 759 pruebas pasaron; 1 prueba falló por configuración nativa excluida |
| Corrección de empaquetado + `npm test -- --runInBand --silent __tests__/engineCompatibility.test.ts` | 1 suite / 3 pruebas PASS; incluye la prueba antes fallida |
| Web `npm test` | 27 archivos de prueba PASS, 0 fallos en este runtime |
| Web `npm run build` | PASS |

Las dependencias instaladas del proyecto local se reutilizaron mediante enlaces
ignorados por Git; no se ejecutó una instalación limpia con los lockfiles durante
esta comprobación. La versión local de Node fue 26.7.0. CI se configura por separado
para instalar desde los lockfiles. No sumar los 3 tests del rerun a los 760 del
conjunto completo: se superponen. No se ejecutaron pruebas SQL ni un piloto físico
durante esta preparación.

La aplicación publicada anteriormente tenía CI móvil/web/base de datos exitoso,
pero ese resultado corresponde a otra revisión. El estado de Actions en esta
publicación será evidencia propia cuando se ejecute.

## Límites conocidos

- Dos migraciones de seguridad presentes en esta copia aún no están desplegadas.
- El entorno privado tiene cambios adicionales de cuentas sin commit, excluidos aquí.
- Siguen pendientes aceptación en dispositivo físico y un pozo real completo.
- Expiración de sesión y carreras entre cambio de cuenta, refresh y sincronización
  necesitan más verificación en flujos reales.
- Un backup exitoso no demuestra recuperación completa de Auth, archivos y claves.
- Entrega de correo con dominio verificado y transferencia de hosting siguen abiertas.
- El build web prueba compilación; no es prueba de login o interacción con un
  backend nuevo. Esta muestra no ofrece un demo público conectado.
