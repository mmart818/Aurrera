# Mi bote

Tus tareas, recompensas y penalizaciones personales, con un bote de monedas. Una sola persona, sin usuarios,
con los datos guardados en Cloudflare (por eso los ves igual desde cualquier dispositivo que abra la URL).

## Cómo funciona

- **Tareas:** pulsas «¡Hecho!» y las monedas entran al bote al momento (Fácil 10, Media 25, Difícil 50).
  Recurrentes: vuelven a la lista. Puntuales: pasan a «Completadas». Las puntuales pueden tener fecha límite con bonus
  (se decide al pulsar «¡Hecho!»; plazo inclusive, zona Europe/Madrid).
- **Recompensas:** cuestan monedas; se canjean cuando el bote llega. Se pueden editar, archivar y reactivar.
- **Penalizaciones:** las marcas tú, con «Penalizar». Restan del bote (por defecto 25, editable con las mismas tres
  cantidades) y **el bote nunca baja de 0**: si hay menos, resta lo que haya y queda anotado.
- **Deshacer:** tareas completadas, canjes y penalizaciones se pueden deshacer, desde el aviso que sale al hacerlo
  o desde el Historial. Una tarea no se puede deshacer si ya has gastado esas monedas (el bote quedaría en negativo):
  primero deshaz el canje.
- **Historial:** Tareas (por meses), Premios, Penalizaciones y Actividad. Los tres primeros son registros permanentes
  (hasta 2.000 de cada uno); Actividad conserva los últimos 300 eventos.

Todo lo inicial (6 tareas, 3 recompensas, 1 penalización) se edita o borra desde la propia app.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `public/index.html` | Toda la interfaz |
| `public/manifest.webmanifest` + iconos | Para añadirla a la pantalla de inicio |
| `worker.js` | API (`GET /api/state`, `POST /api/action`). Toda la lógica de monedas está aquí |
| `wrangler.toml` | Configuración del despliegue (Worker + archivos estáticos + KV) |
| `functions/api/[[path]].js` | Solo si usas Cloudflare Pages en vez de un Worker |

## Desplegar (unos 5 minutos)

Es un proyecto independiente: su propio Worker (`mi-bote`) y su propio KV, sin tocar los de la app de pareja.
Necesitas Node.js y una cuenta de Cloudflare (el plan gratuito basta).

```bash
cd mi-bote

# 1. Entrar en tu cuenta
npx wrangler login

# 2. Crear la base de datos KV y pegar el "id" que muestra en wrangler.toml
npx wrangler kv namespace create BOTE_KV

# 3. Publicar
npx wrangler deploy
```

Te da una URL tipo `https://mi-bote.<tu-subdominio>.workers.dev`. Ábrela en el móvil y usa «Añadir a pantalla de inicio».
La primera petición crea los datos iniciales en KV.

### Código de acceso (recomendado)

Sin código, cualquiera que conozca la URL puede leer y modificar tus datos:

```bash
npx wrangler secret put APP_CODE
```

La app lo pide una vez y el dispositivo lo recuerda. Quitarlo: `npx wrangler secret delete APP_CODE`.

### Si lo despliegas en Cloudflare Pages

1. Sube **todo el proyecto** (no solo `index.html`) con `public` como directorio de salida.
2. En Pages > tu proyecto > Settings > Bindings, añade un **KV namespace** con el nombre de variable `BOTE_KV` y vuelve a desplegar.
3. (Opcional) Añade `APP_CODE` en el mismo panel.

Si solo subes `index.html`, la página carga pero no hay API y verás «No se encuentra la API (/api/state)».

## Límites del plan gratuito de KV

100.000 lecturas y 1.000 escrituras al día. Para uso personal sobra: cada acción es una escritura y la app
solo lee al abrirla o al volver a ella. KV es «eventualmente consistente» (otra ubicación de Cloudflare puede tardar
hasta ~60 s en ver un cambio), pero al ser una sola persona casi nunca se nota.
