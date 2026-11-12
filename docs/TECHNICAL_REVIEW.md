# Guía técnica

## Persistencia y sincronización

Comenzar en [SQLite](../PHC_Mobile/phc-native/src/db/index.ts), continuar con
[drillingSync](../PHC_Mobile/phc-native/src/sync/drillingSync.ts),
[drainCoordinator](../PHC_Mobile/phc-native/src/sync/drainCoordinator.ts) y
[productV2Sync](../PHC_Mobile/phc-native/src/sync/productV2Sync.ts).

Revisar cómo se conserva la operación, cómo se resuelven dependencias, cuándo se
reintenta y cómo se registra un rechazo. Las pruebas de
[atomicidad](../PHC_Mobile/phc-native/__tests__/outboxAtomicity.test.ts) y
[propiedad de la cola](../PHC_Mobile/phc-native/__tests__/outboxOwner.test.ts)
permiten discutir fallos concretos. Los mocks no equivalen a probar todos los
fallos del almacenamiento o del dispositivo real.

## Reglas de negocio

Las [migraciones](../supabase/migrations/) son ordenadas: una función introducida
por una migración puede ser reemplazada por otra posterior. El plan de producto
v2 contiene `decide_pedido_item`, `confirm_pedido_item_receipt` y
`sign_completion_report`. Buscar esas funciones y sus redefiniciones permite
seguir decisiones, recepción y finalización atómica.

Las funciones privilegiadas necesitan controles de identidad, autorización y
permisos de ejecución. Usar `SECURITY DEFINER` no garantiza seguridad por sí solo.
Las últimas dos migraciones de esta muestra endurecen lecturas por asignación
actual y visibilidad de notificaciones; aún no estaban aplicadas en producción
al realizar la comparación.

## Web y separación de responsabilidades

Revisar [App.tsx](../PHC_Web_Admin/src/App.tsx), las
[reglas de dominio](../PHC_Web_Admin/src/domain/) y la
[API de cierre](../PHC_Web_Admin/src/api/supabase-completion.ts).
La interfaz guía al usuario; el backend debe volver a validar permisos e
invariantes. La consola de operador en navegador es una superficie de QA online,
no una demostración de sincronización offline Android.

## Preguntas útiles para conversar

- ¿Qué ocurre si el servidor acepta una operación y se pierde la respuesta?
- ¿Qué diferencia hay entre quien registró trabajo y quien lo sube después?
- ¿Qué ocurre con trabajo pendiente cuando cambia una asignación?
- ¿Qué validaciones deben existir en servidor aunque la interfaz ya las haga?
- ¿Qué pruebas dependen de mocks y qué queda por comprobar en hardware?
- ¿Qué parte de la implementación simplificaríamos tras observar el primer piloto?

La revisión puede evaluar el resultado y el proceso asistido por IA. No se presenta
esta muestra como prueba de autoría manual ni de dominio individual de cada línea.
