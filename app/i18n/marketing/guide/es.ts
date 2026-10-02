import type { GuideCopy } from "./types";

export const guideEs: GuideCopy = {
  categories: {
    "getting-started": {
      title: "Primeros pasos",
      intro: "Instalar la app, conectar tu proveedor de IA y orientarte dentro de ella.",
    },
    "ai-content": {
      title: "Crear contenido con IA",
      intro: "Escribir, mejorar y crear contenido siguiendo tus propias reglas.",
    },
    translations: {
      title: "Traducciones",
      intro: "Cada idioma, cada mercado y cada texto de tu tienda — y qué ocurre cuando cambia el original.",
    },
    bulk: {
      title: "Editor masivo",
      intro: "Editar todo el catálogo en una tabla, exportarlo, importarlo y completar las traducciones que faltan.",
    },
    media: {
      title: "Imágenes y medios",
      intro: "El Image Variant Manager, los textos alternativos y el procesamiento de imágenes.",
    },
    seo: {
      title: "Palabras clave y SEO",
      intro: "Planificar palabras clave, rastrear tu propia tienda y poner en orden el SEO técnico.",
    },
    "ai-visibility": {
      title: "Visibilidad en asistentes de IA",
      intro: "Qué pueden leer ChatGPT, Perplexity y compañía sobre tu tienda — y cómo controlarlo.",
    },
    "shop-data": {
      title: "Datos de producto y textos de la tienda",
      intro: "Atributos de merchandising, precios, inventario, reglas de colecciones y los textos del checkout.",
    },
  },

  topics: {
    setup: {
      title: "Instalación y primera sincronización",
      summary:
        "Cómo instalar la app, qué ocurre al iniciarla por primera vez y por qué trabaja con una copia local de tu contenido.",
      sections: [
        {
          heading: "Instalar",
          paragraphs: [
            "ContentPilot AI se instala desde la Shopify App Store. Shopify te muestra qué datos puede leer y escribir la app — no se instala nada hasta que lo apruebas allí. Después la app se abre directamente en tu panel de Shopify.",
          ],
        },
        {
          heading: "La primera sincronización",
          paragraphs: [
            "Al iniciarse por primera vez, la app lee tu contenido de Shopify: productos, colecciones, páginas, blogs, artículos, menús, metaobjetos y sus traducciones. Según el catálogo tarda de unos segundos a unos minutos; el progreso se ejecuta como tarea en segundo plano.",
            "La app trabaja con esta copia local para que las listas, los filtros y los resúmenes sean rápidos. Pero siempre escribe primero en Shopify — un cambio solo cuenta como guardado cuando Shopify lo confirma.",
          ],
        },
        {
          heading: "Recargar",
          paragraphs: [
            "Los productos y las colecciones se mantienen al día automáticamente mediante los webhooks de Shopify. Las páginas, los blogs y los artículos no tienen esas notificaciones; si los cambias fuera de la app, recarga la entrada con el botón de recarga del editor. El contenido totalmente nuevo aparece tras una sincronización completa.",
          ],
        },
      ],
      tips: [
        "Cuántos productos, idiomas y tipos de contenido puedes editar depende de tu plan. El uso actual aparece en Ajustes → Plan.",
      ],
    },

    "ai-providers": {
      title: "Proveedores de IA y claves API",
      summary: "La IA puede venir incluida en tu plan, o usas tu propio acceso. Cómo funcionan ambos y cómo elegir modelo y límites.",
      sections: [
        {
          heading: "Tu propia clave",
          paragraphs: [
            "ContentPilot AI escribe con el proveedor de IA que conectes: Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Grok o HuggingFace. Introduces tu propia clave API, así que el coste y la elección del modelo siguen siendo tuyos.",
          ],
          steps: [
            "Crea una cuenta en un proveedor y genera una clave API.",
            "En la app, abre Ajustes → Acceso a la API de IA e introduce la clave en ese proveedor.",
            "Elige el proveedor y el modelo preferidos y guarda.",
          ],
        },
        {
          heading: "IA incluida en el plan",
          paragraphs: [
            "En lugar de tu propia clave, puedes elegir un plan con IA incluida. En Ajustes → Plan, activa arriba «Con IA incluida»: las tarjetas muestran entonces el precio con IA y aproximadamente cuánto trabajo incluye. Cambias de plan como siempre con el botón de cada tarjeta.",
            "Qué IA se usa lo decide solo tu plan: con un plan con IA, la app trabaja con la IA incluida. Sin él, usa tu propia clave en cuanto hay una guardada. Si no tienes ninguna de las dos, puedes probar la IA incluida una vez gratis.",
            "Antes de que la IA incluida trabaje, confirmas una vez en Ajustes → Acceso a la API de IA que tu contenido puede enviarse a los proveedores de IA indicados. Ahí ves también cuánto del volumen incluido has usado en el periodo de facturación actual.",
            "Cuando se agota el volumen, la app sigue con tu propia clave si has guardado una. Si no, continúa en el siguiente periodo de facturación. Las traducciones nunca se borran solo porque se haya agotado el volumen.",
          ],
        },
        {
          heading: "Límites por minuto",
          paragraphs: [
            "Para cada proveedor puedes limitar los tokens y las solicitudes por minuto. Importa en ejecuciones grandes, como traducir todo el catálogo: no pongas valores más altos de lo que permite tu cuenta, o el proveedor rechazará solicitudes.",
          ],
        },
        {
          heading: "Enviar imágenes a la IA",
          paragraphs: [
            "Si la IA puede ver tus imágenes de producto es un único ajuste para toda la tienda (Ajustes → Instrucciones de IA → General). Viene desactivado. Activado, un texto alternativo describe la imagen real y los textos de producto pueden recoger detalles visibles. HuggingFace y DeepSeek no admiten imágenes.",
          ],
        },
      ],
      tips: ["La clave se guarda cifrada. Si sospechas un uso indebido, sustitúyela en el proveedor e introduce la nueva."],
    },

    "app-tour": {
      title: "Recorrido por la app",
      summary: "Las cinco áreas principales — Contenido, Masivo, SEO, Tareas, Ajustes — y dónde está cada cosa.",
      sections: [
        {
          heading: "La navegación principal",
          paragraphs: ["En la parte superior de la app encontrarás cinco áreas:"],
          list: [
            "Contenido — el editor de cada tipo de contenido: catálogo (productos, colecciones, planes de suscripción), tienda online (blogs, páginas, políticas, menús, metaobjetos, filtros, banner de cookies), textos del tema, textos del sistema y traducciones directas.",
            "Masivo — el editor masivo, una hoja de cálculo sobre toda la tienda.",
            "SEO — resumen, análisis (velocidad, rastreo, hreflang), posicionamiento (palabras clave, Search Console), enlaces (redirecciones, enlaces internos) y técnico (datos estructurados, sitemap, IndexNow, búsqueda con IA).",
            "Tareas — todo lo que se ejecuta en segundo plano.",
            "Ajustes — acceso a la IA, instrucciones de IA, glosario, ajustes de SEO, plan.",
          ],
        },
        {
          heading: "Guardar",
          paragraphs: [
            "No se escribe nada antes de guardar. En cuanto cambias algo, aparece arriba la barra de guardado de Shopify con Guardar y Descartar. También vale para los interruptores de los ajustes: un cambio es un borrador hasta que lo guardas.",
          ],
        },
        {
          heading: "Tiendas de un solo idioma",
          paragraphs: [
            "Si tu tienda solo tiene un idioma, la app oculta las barras de idioma. Los botones de traducción siguen visibles pero en gris, con la indicación de que hace falta un segundo idioma — así ves lo que sería posible.",
          ],
        },
      ],
    },

    "storefront-embeds": {
      title: "Activar los app embeds en tu tema",
      summary:
        "Algunas funciones necesitan una pequeña pieza en tu tienda. Cómo activar los app embeds — sin tocar el código de tu tema.",
      sections: [
        {
          heading: "Qué es un app embed",
          paragraphs: [
            "Shopify permite a las apps añadir funciones a la tienda mediante «app embeds» que activas y desactivas en el editor de temas. ContentPilot AI nunca modifica el código de tu tema; todo lo que aparece en la tienda pasa por estos interruptores.",
          ],
          list: [
            "Datos estructurados (JSON-LD) — marcado para resultados enriquecidos en Google.",
            "Open Graph / vistas previas sociales — imagen, título y descripción al compartir enlaces.",
            "Galería de variantes — muestra las imágenes de cada variante.",
            "Selector de idioma y país — un selector basado en la localización propia de Shopify.",
            "Traducciones directas — traduce textos de otras apps.",
            "Imágenes y vídeos por idioma — muestra las imágenes y vídeos de producto que reemplazaste por idioma o mercado.",
            "Web Vitals — mide la velocidad para visitantes reales.",
          ],
        },
        {
          heading: "Activar",
          paragraphs: [],
          steps: [
            "En la app, abre Contenido → Tema → App embeds (o usa el aviso de la sección correspondiente).",
            "Pulsa el botón de activar del embed que quieras — el editor de temas se abre con ese embed seleccionado.",
            "Actívalo, ajusta su configuración si hace falta y guarda el tema.",
          ],
        },
      ],
      tips: [
        "Si tu tema ya genera un tipo de marcado, desactiva ese mismo tipo en la app — el marcado duplicado provoca avisos en Search Console. La app lo comprueba por ti (ver «Datos estructurados»).",
      ],
    },

    tasks: {
      title: "Tareas y procesos en segundo plano",
      summary: "Los trabajos largos se ejecutan como tareas en segundo plano. Cómo seguirles la pista.",
      sections: [
        {
          heading: "Qué es una tarea",
          paragraphs: [
            "Traducir a todos los idiomas, guardados masivos grandes, un rastreo, ejecuciones de IA sobre muchas entradas: todo lo que tarda más de un momento empieza como tarea. Mientras tanto puedes seguir trabajando o salir de la página.",
            "La campana de la parte superior muestra cuántas tareas están en marcha y avisa cuando una termina. En Tareas tienes la lista completa con estado, progreso y — si falla — el motivo.",
          ],
        },
        {
          heading: "Los estados",
          paragraphs: [],
          list: [
            "En espera — la tarea está en la cola.",
            "En curso — se está procesando.",
            "Completada — todo ha salido bien.",
            "Completada con errores — una parte ha funcionado, el resto aparece detallado.",
            "Fallida — no se ha escrito nada; el motivo está en la tarea.",
          ],
        },
      ],
      tips: [
        "Cuando el editor masivo inicia una tarea, la tabla se recarga sola en cuanto termina — no hace falta actualizar a mano.",
      ],
    },

    "content-editor": {
      title: "El editor de contenido",
      summary:
        "Un editor para productos, colecciones, páginas, artículos y más: lista a la izquierda, campos en el centro, barra de SEO a la derecha.",
      sections: [
        {
          heading: "Estructura",
          paragraphs: [
            "Cada tipo de contenido abre el mismo editor. A la izquierda eliges la entrada en una lista con búsqueda, en el centro editas sus campos y a la derecha la barra lateral muestra la puntuación SEO, las palabras clave, la legibilidad y los datos estructurados de esa entrada.",
            "Arriba está la barra de idiomas. En el idioma principal editas el original; en cualquier otro, su traducción. Unas marcas de color indican dónde falta una traducción.",
          ],
        },
        {
          heading: "Campos",
          paragraphs: [
            "Los campos de texto (título, descripción, título SEO, meta descripción, handle) llevan debajo una fila de botones de IA: generar (con el campo vacío) o mejorar, formatear y traducir. Cada campo tiene un signo de interrogación que explica para qué sirve y un botón para vaciarlo.",
            "En el área Detalles están los atributos que no se traducen: proveedor, etiquetas, categoría, colecciones, plantilla del tema, visibilidad — y en los productos también precios, inventario y canales de venta.",
          ],
        },
        {
          heading: "Guardar y descartar",
          paragraphs: [
            "Los campos modificados se acumulan hasta que guardas. Solo se escriben los que realmente has cambiado, así que un título nuevo nunca sobrescribe por accidente las etiquetas o la descripción.",
          ],
        },
      ],
    },

    "ai-generate": {
      title: "Generar, mejorar y formatear textos",
      summary: "Los botones de IA de cada campo de texto — y qué hace cada uno con tu texto.",
      sections: [
        {
          heading: "Generar o mejorar — un solo botón",
          paragraphs: [
            "Bajo cada campo de texto hay un botón de IA cuya etiqueta depende del campo. Si el campo está vacío, se llama «Generar con IA» y escribe un texto nuevo. La IA recibe el contexto de la entrada — título, tipo de producto, etiquetas y, si lo permites, la imagen — y tus instrucciones para ese campo.",
            "Si el campo ya tiene texto, el mismo botón se llama «Mejorar con IA» y reescribe libremente el texto existente: más claro, mejor estructurado, más cerca de tus reglas de estilo y de las palabras clave asignadas.",
            "Antes de empezar puedes darle a la IA una instrucción solo para esta ejecución, por ejemplo «Destaca la calidad de la lana». Tiene prioridad sobre todas las demás reglas.",
          ],
        },
        {
          heading: "Formatear",
          paragraphs: [
            "No cambia el contenido, solo la forma: mayúsculas, puntuación, párrafos y listas. Útil para que muchos productos tengan un aspecto uniforme.",
          ],
        },
        {
          heading: "Aceptar una sugerencia",
          paragraphs: [
            "El resultado llega al campo como sugerencia. Puedes aceptarla, descartarla o seguir editándola — nada se guarda a tus espaldas. «Aceptar y traducir» lleva el texto aceptado directamente a todos los idiomas.",
          ],
        },
      ],
      tips: [
        "El título SEO y la meta descripción tienen sus propios límites de longitud. La IA los respeta, y el contador bajo el campo muestra dónde cortaría Google el texto.",
      ],
    },

    "ai-instructions": {
      title: "Instrucciones de IA y reglas de estilo",
      summary: "Cómo enseñar a la IA tu tono, tus formatos y tus reglas para cada campo.",
      sections: [
        {
          heading: "Dónde",
          paragraphs: ["En Ajustes → Instrucciones de IA hay varios niveles:"],
          list: [
            "Estilo de escritura — tono, tratamiento, longitud de frase y preferencias de idioma para todos los textos generados.",
            "Formato — cómo da forma a los textos la acción Formatear.",
            "Traducción — tono y reglas para las traducciones con IA (formal o informal, por ejemplo).",
            "Por campo y tipo de contenido — un ejemplo de resultado y reglas detalladas, como «Descripción de producto: tres párrafos, una lista de materiales».",
          ],
        },
        {
          heading: "Escribir buenas instrucciones",
          paragraphs: [
            "Cuanto más concretas, más uniforme el resultado. Un ejemplo real y breve de tu tienda suele funcionar mejor que una larga lista de reglas. Di qué debe evitar la IA (superlativos, ciertas palabras) y qué longitud esperas.",
          ],
        },
      ],
      tips: [
        "Las instrucciones modificadas se aplican a las generaciones nuevas. Los textos existentes solo cambian cuando los vuelves a generar o mejorar.",
        "Si un término no debe traducirse nunca, o siempre igual, va en el glosario, no en las instrucciones.",
      ],
    },

    "create-content": {
      title: "Crear contenido nuevo",
      summary:
        "Crea productos, colecciones, páginas, artículos y metaobjetos directamente en la app — si quieres, con textos de IA y ya traducidos.",
      sections: [
        {
          heading: "El diálogo de creación",
          paragraphs: [
            "En la lista de cada tipo de contenido, «Nuevo» abre un diálogo con los campos más importantes. Los campos obligatorios llevan un asterisco rojo. Los demás se despliegan cuando los necesitas.",
          ],
        },
        {
          heading: "Completar con IA y traducir",
          paragraphs: [
            "Al final del diálogo hay dos interruptores: «Escribir el resto con IA» rellena todos los campos que dejaste vacíos (descripción y textos SEO, por ejemplo) a partir de lo que introdujiste. «Traducir después» lleva el resultado a todos los idiomas. Si adjuntaste una imagen y el envío de imágenes está activado, la IA puede tenerla en cuenta.",
          ],
        },
        {
          heading: "Sin publicar",
          paragraphs: [
            "Todo lo que crea la app se crea sin publicar. Lo revisas en el editor y lo haces visible cuando esté listo.",
          ],
        },
      ],
    },

    translating: {
      title: "Traducir en el editor",
      summary: "Traducir un campo, traducirlo todo, elegir idiomas — y qué cuenta como «guardado».",
      sections: [
        {
          heading: "Un campo o todo",
          paragraphs: [
            "Elige un idioma extranjero arriba. Cada campo tiene ahora un botón de traducir que trae el texto del idioma principal. En el idioma principal, el botón del globo traduce un campo a todos los idiomas a la vez; «Traducir todo» en la barra de acciones traduce la entrada entera.",
            "Con Ctrl+clic (Mac: Cmd+clic) sobre un botón de idioma lo excluyes de esas ejecuciones — por ejemplo, si lo traduces a mano.",
          ],
        },
        {
          heading: "Qué se traduce",
          paragraphs: [
            "Títulos, descripciones, textos SEO, handles, textos alternativos, opciones de producto y sus valores, metacampos, campos de metaobjetos, menús, textos del tema y del sistema. Qué metacampos de producto adicionales se incluyen se define en Ajustes → Metafields, incluidos los de otras apps.",
          ],
        },
        {
          heading: "Guardado significa confirmado",
          paragraphs: [
            "Una traducción solo cuenta como guardada cuando Shopify la devuelve. Si Shopify no acepta una traducción, lo ves en el campo afectado — en lugar de un mensaje de éxito sobre algo que nunca llegó.",
            "Lo mismo vale al vaciar: una traducción solo cuenta como eliminada cuando Shopify lo confirma; si no, sigue visible, el campo sigue marcado como modificado para que puedas guardar de nuevo, y se te avisa. En las opciones de producto y los metacampos, un idioma que Shopify rechazó se nombra en la tarea, que entonces aparece como “completada con errores”.",
          ],
        },
      ],
      tips: ["Las traducciones que escribes tú nunca las sobrescribe la IA. La IA solo rellena lo que le pides."],
    },

    glossary: {
      title: "Glosario",
      summary: "Decide qué términos no se traducen nunca y cuáles reciben siempre la misma traducción.",
      sections: [
        {
          heading: "Para qué sirve",
          paragraphs: [
            "Las marcas, las líneas de producto y los términos técnicos tienen que ser correctos en todos los idiomas. En el glosario (Ajustes → Instrucciones de IA → Glosario) introduces un término en el idioma principal y decides por idioma si se queda igual o recibe una traducción fija.",
          ],
        },
        {
          heading: "Cuándo se aplica",
          paragraphs: [
            "El glosario se añade automáticamente a cada traducción con IA — en el editor, en el editor masivo y en las traducciones automáticas. No se aplica al generar textos nuevos en el idioma principal; para eso están las instrucciones de IA.",
          ],
        },
      ],
      tips: [
        "Las entradas nuevas del glosario valen para traducciones nuevas. Las existentes solo cambian cuando vuelves a traducirlas.",
      ],
    },

    markets: {
      title: "Mercados y traducciones por mercado",
      summary: "Alemán para Suiza distinto del alemán para Alemania: cómo trata la app los mercados de Shopify.",
      sections: [
        {
          heading: "Dos capas",
          paragraphs: [
            "Shopify guarda una traducción global por idioma. Con Shopify Markets puede existir además una versión para un solo mercado que tiene prioridad allí — «Velo» en lugar de «Fahrrad» para Suiza, por ejemplo.",
            "En la app eliges el mercado junto al idioma. Sin mercado editas la traducción global; con mercado, la variante de exactamente ese mercado.",
          ],
        },
        {
          heading: "Conviene saber",
          paragraphs: [],
          list: [
            "Solo se ofrecen los mercados activos.",
            "El handle de la URL no puede variar por mercado — Shopify permite uno por idioma.",
            "Cuando cambia el texto original, la variante de mercado se elimina en cuanto se elimina o se vuelve a traducir la traducción global. Una variante de mercado nunca se retraduce automáticamente: es tu propia redacción.",
          ],
        },
      ],
    },

    "source-changes": {
      title: "Cuando cambia el texto original",
      summary:
        "Una traducción de un texto que ya no existe es peor que ninguna. Tú decides si se borra o se vuelve a traducir.",
      sections: [
        {
          heading: "El problema",
          paragraphs: [
            "Cambias la descripción de un producto y la versión francesa sigue describiendo el producto antiguo. Shopify solo la marca como «desactualizada»; en la tienda sigue visible.",
          ],
        },
        {
          heading: "Tus dos opciones",
          paragraphs: ["En Ajustes → Instrucciones de IA → Traducciones:"],
          list: [
            "Borrar traducciones al cambiar (por defecto: activado) — se elimina la traducción desactualizada. La tienda muestra entonces el texto original en ese idioma hasta que vuelvas a traducir.",
            "Retraducir automáticamente (plan Max) — la IA traduce el texto nuevo a todos los idiomas publicados, incluso a los que nunca tuvieron ese campo. Esta opción sustituye al borrado.",
          ],
        },
        {
          heading: "También con cambios fuera de la app",
          paragraphs: [
            "Si editas textos en el panel de Shopify, con otra app o mediante una importación, la app lo detecta: en productos y colecciones al instante mediante las notificaciones de Shopify; en páginas, artículos, blogs y políticas mediante una comprobación diaria. Las traducciones se tratan entonces según tu ajuste.",
            "Las traducciones automáticas se ejecutan como tarea en segundo plano. Si mientras tanto guardas tú una traducción, prevalece tu versión.",
          ],
        },
      ],
    },

    "translated-handles": {
      title: "URL traducidas y redirecciones",
      summary:
        "Un handle traducido da a cada idioma su propia dirección. La app crea la redirección que necesita cada cambio.",
      sections: [
        {
          heading: "Qué es un handle",
          paragraphs: [
            "El handle es la parte de la URL tras /products/ o /pages/. Traducido, en español queda /es/products/caja-de-madera en lugar de /es/products/holzbox. Eso ayuda al posicionamiento en cada idioma.",
          ],
        },
        {
          heading: "Redirecciones",
          paragraphs: [
            "Si cambias un handle — en el original o en una traducción —, la dirección antigua deja de llevar a ninguna parte. Por eso la app crea automáticamente una redirección 301 de la dirección antigua a la nueva, repara de paso las cadenas de redirecciones existentes y elimina una redirección si vuelves al handle anterior.",
          ],
        },
        {
          heading: "Retraducción automática",
          paragraphs: [
            "Los handles solo se retraducen automáticamente si además lo activas de forma explícita — cambiar una URL es una decisión aparte. Incluso entonces un handle solo se actualiza donde ya estaba traducido y donde es posible una redirección. Los handles de blog nunca se cambian automáticamente, porque una redirección no puede cubrir los artículos que cuelgan de él.",
          ],
        },
      ],
    },

    "theme-content": {
      title: "Traducir los textos del tema",
      summary: "Botones, etiquetas, secciones y ajustes del tema — los textos que viven dentro de tu tema.",
      sections: [
        {
          heading: "Las áreas",
          paragraphs: ["En Contenido → Tema están los textos de tu tema publicado, divididos como en Shopify:"],
          list: [
            "Contenido predeterminado — el archivo de idioma del tema: «Añadir al carrito», «Agotado», etiquetas de formularios.",
            "Grupos de secciones y secciones estáticas — cabecera, pie y secciones fijas.",
            "Plantillas — las secciones de las páginas de producto, colección y otras.",
            "Ajustes del tema — textos guardados en los ajustes del tema.",
            "App embeds — contenido técnico, solo lectura.",
          ],
        },
        {
          heading: "Por tema y por mercado",
          paragraphs: [
            "Las traducciones del tema pertenecen a un tema concreto. Si cambias de tema, hay que traducir los textos del nuevo. Como en el resto del contenido, puedes añadir versiones por mercado.",
          ],
        },
      ],
      tips: [
        "Las imágenes del tema aparecen como vista previa. Puedes elegir otra imagen por idioma y mercado; consulta «Imágenes y vídeos distintos por idioma».",
        "Si cambias un texto del tema en el idioma principal, sus traducciones se borran o se retraducen según tu ajuste — igual que en los productos.",
      ],
    },

    "images-per-language": {
      title: "Imágenes y vídeos distintos por idioma",
      summary:
        "Muestra a los clientes de un idioma o mercado otra imagen, por ejemplo un banner o una foto de producto con el texto traducido.",
      sections: [
        {
          heading: "Para qué sirve",
          paragraphs: [
            "El texto se puede traducir; el texto dentro de una imagen, no. Un banner que dice «Sale» o una foto de producto con etiquetas en alemán se ve igual en todos los idiomas. Con «Imágenes y vídeos por idioma» eliges otra imagen para un idioma y, si quieres, solo para un mercado. Reemplaza al original uno a uno; los demás idiomas siguen viendo la imagen original.",
          ],
        },
        {
          heading: "Imágenes del tema",
          paragraphs: [
            "Las imágenes de tu tema (por ejemplo un banner en la página de inicio) están en Contenido → Tema, entre los textos de su sección. En lugar de un campo de texto ves una vista previa de la imagen.",
            "Que tu tema muestre la imagen del idioma elegido depende del tema. Tras guardar, comprueba tu tienda en ese idioma; algunos temas pueden seguir mostrando la imagen original.",
          ],
          steps: [
            "Elige el idioma arriba y, si la imagen solo debe cambiar en un mercado, el mercado.",
            "Haz clic en «Elegir imagen para este idioma» junto a la imagen y elige una de tus archivos o súbela.",
            "Guarda. Con «Usar imagen original» deshaces la elección.",
          ],
        },
        {
          heading: "Imágenes de producto",
          paragraphs: [
            "Defines un reemplazo directamente en la galería de imágenes del producto, también si el gestor de imágenes está desactivado. En el idioma principal no hay nada especial. Cambia a un idioma extranjero (y, si quieres, a un mercado) y selecciona una imagen de la galería: en la fila de botones de la selección aparece, entre «Mover» y «Eliminar», el botón «Subir imagen de reemplazo». Al hacer clic se abren tus archivos, donde eliges una imagen o subes una nueva; solo se ofrece lo que puede reemplazar al original. La imagen elegida aparece enseguida en la galería, en lugar del original, marcada con un pequeño símbolo redondo en la esquina superior izquierda. Solo se guarda cuando pulsas «Guardar» arriba; el cuadro de información comunica el resultado. «Descartar» deshace tu elección. Un clic en el símbolo te muestra el original (el símbolo se vuelve gris) y otro clic vuelve a mostrar el reemplazo. «Quitar imagen de reemplazo» hace que vuelva a valer el original, y eso también se aplica solo con «Guardar». Usa una imagen con las mismas proporciones que la original: la tienda mantiene el marco de la original, así que otro formato se recorta o deja huecos.",
            "Para que tu tienda muestre los reemplazos, activa una vez la inserción de app «Images and videos per language» (el mensaje tras guardar enlaza directamente). Se reemplazan las imágenes de la galería de la página de producto y la imagen que aparece al compartir el enlace y en los buscadores.",
          ],
          list: [
            "Un reemplazo para un mercado concreto tiene prioridad sobre el reemplazo para «Todos los mercados».",
            "Tus elecciones valen por idioma y mercado: puedes elegir algo en un idioma, cambiar a otro y aplicarlo todo al final con un clic en «Guardar».",
            "Si eliminas una imagen en la app, también se eliminan todas sus imágenes de reemplazo (en cada idioma y mercado).",
            "Si tu plan no incluye (o ya no incluye) imágenes y vídeos de reemplazo, por ejemplo tras un cambio de plan, tu tienda sigue mostrando los reemplazos que ya existen. Los ves en la galería y puedes quitarlos allí; ya no se pueden definir otros nuevos. Un vídeo subido puede tardar unos minutos en procesarse en Shopify; el archivo ya está en tus archivos y puedes elegirlo desde allí.",
            "Si hay imágenes de reemplazo que ya no pertenecen a nada (por ejemplo a un mercado o idioma que ya no existe en tu tienda), aparece una advertencia bajo la galería donde puedes quitarlas. Si conviertes una imagen a WebP, las imágenes de reemplazo de la imagen antigua se trasladan automáticamente al archivo nuevo; solo si eso falla aparecen en esta advertencia y hay que volver a definirlas. Las imágenes de reemplazo sin guardar de un idioma extranjero se conservan al pasar al idioma principal; una línea bajo la galería indica los idiomas en los que algo espera todavía a «Guardar».",
          ],
        },
        {
          heading: "Vídeos",
          paragraphs: [
            "Del mismo modo también reemplazas los vídeos de un producto por idioma y mercado, por ejemplo por una versión doblada. Un vídeo subido a Shopify se reemplaza por otro vídeo subido (de tus archivos o subido nuevo), un vídeo de YouTube o Vimeo por otro enlace de YouTube o Vimeo. Una imagen no se puede reemplazar por un vídeo ni al revés; los modelos 3D no se reemplazan.",
            "Shopify procesa un vídeo recién subido durante unos minutos. Si aparece un aviso, elige el vídeo de tus archivos un poco más tarde.",
            "Los vídeos de los ajustes del tema (por ejemplo una sección de vídeo en la página de inicio) se introducen por idioma como otro enlace; la IA no los modifica.",
          ],
        },
        {
          heading: "Qué no se reemplaza",
          paragraphs: [
            "Las tarjetas de producto en las colecciones, el carrito y los feeds de Google Shopping, la app Shop y otros canales de venta siguen mostrando el original. En los vídeos, la descripción del vídeo para los buscadores sigue siendo la del original. Las imágenes de colecciones y blogs aún no están incluidas.",
          ],
        },
      ],
      tips: [
        "La IA no traduce ni modifica imágenes. Por eso los botones de traducir no ofrecen nada para las imágenes del tema: una imagen se mantiene hasta que eliges otra.",
        "Una imagen que se mantiene igual en un idioma no cuenta como traducción pendiente.",
      ],
    },

    "direct-translations": {
      title: "Traducciones directas para textos de otras apps",
      summary:
        "Widgets de reseñas, insignias, constructores de páginas: los textos que las traducciones de Shopify no alcanzan se traducen aquí.",
      sections: [
        {
          heading: "Para qué sirve",
          paragraphs: [
            "Muchas apps escriben sus textos directamente en la tienda sin ofrecérselos a Shopify para traducirlos, así que se ven igual en todos los idiomas. Las traducciones directas capturan esos textos y los sustituyen en el navegador del visitante por tu traducción.",
          ],
        },
        {
          heading: "Cómo funciona",
          paragraphs: [],
          steps: [
            "Activa el app embed «Traducciones directas» en el editor de temas.",
            "En Contenido → Traducciones directas, activa la recogida y guarda.",
            "Visita tu tienda — los textos encontrados aparecerán después en la lista.",
            "Traduce las entradas, una a una o con IA, y guarda.",
          ],
        },
      ],
      tips: [
        "A diferencia del resto, aquí también se ofrece el idioma principal como destino: el texto de otra app puede estar en cualquier idioma.",
      ],
    },

    menus: {
      title: "Editar y traducir menús",
      summary: "Renombrar, reordenar, anidar y cambiar destinos — sin perder traducciones.",
      sections: [
        {
          heading: "Un editor de menús completo",
          paragraphs: [
            "En Contenido → Menús editas tu navegación como un árbol: añadir, borrar, renombrar, arrastrar para mover y anidar hasta tres niveles. El destino de un elemento se elige entre productos, colecciones, páginas, blogs, artículos, políticas, metaobjetos o una URL libre.",
          ],
        },
        {
          heading: "Las traducciones se conservan",
          paragraphs: [
            "En Shopify, mover un elemento del menú bajo otro elemento padre borra sus traducciones. La app las guarda antes de guardar y las restaura después — también para todos los subelementos y las versiones por mercado.",
          ],
        },
        {
          heading: "Cuidado con los cambios simultáneos",
          paragraphs: [
            "Shopify siempre guarda un menú completo. Si alguien lo ha cambiado en otro sitio mientras tanto, la app se niega a guardar y te dice qué ha cambiado — en lugar de sobrescribir el otro cambio sin avisar.",
          ],
        },
      ],
    },

    metaobjects: {
      title: "Metaobjetos",
      summary: "Crear, editar, traducir y borrar entradas — campo a campo.",
      sections: [
        {
          heading: "Editar entradas",
          paragraphs: [
            "En Contenido → Metaobjetos ves tus tipos de metaobjeto y sus entradas. Cada entrada es una tarjeta con todos sus campos; los de texto se pueden editar, rellenar con IA y traducir, y los colores y archivos se eligen.",
          ],
        },
        {
          heading: "Entradas nuevas y taxonomía",
          paragraphs: [
            "Las entradas nuevas se crean con el diálogo de creación. Los campos que remiten a la taxonomía de productos de Shopify (color o estampado, por ejemplo) se eligen de la lista de valores permitidos.",
          ],
        },
        {
          heading: "Borrar",
          paragraphs: [
            "Antes de borrar, la app muestra cuántos productos usan una entrada. Si una entrada sigue en uso, Shopify rechaza el borrado. También se pueden borrar tipos de metaobjeto completos — Shopify elimina con ellos todas sus entradas.",
          ],
        },
      ],
      tips: [
        "Shopify decide qué campos son traducibles. Los colores, los archivos y los valores de taxonomía existen una vez por tienda, no por idioma.",
      ],
    },

    "bulk-editor": {
      title: "El editor masivo",
      summary:
        "Una hoja de cálculo sobre toda la tienda: filtra, cambia cientos de celdas y guarda solo lo que has tocado.",
      sections: [
        {
          heading: "Qué contiene",
          paragraphs: [
            "El editor masivo (el área Masivo) muestra productos, variantes, colecciones, artículos, páginas, blogs, políticas, metaobjetos e imágenes como filas. Tú eliges qué columnas ves — títulos, textos SEO, handles, metacampos, opciones, textos alternativos, precios, atributos de merchandising —, también varios idiomas en paralelo.",
          ],
        },
        {
          heading: "Editar",
          paragraphs: [
            "Filtra las filas que te interesan y escribe directamente en las celdas. Puedes pegar rangos rectangulares como en una hoja de cálculo. Las celdas modificadas quedan resaltadas y se pueden deshacer pasos.",
          ],
        },
        {
          heading: "Guardar",
          paragraphs: [
            "Solo se guardan las celdas modificadas. Si Shopify rechaza un valor, se marca como fallida exactamente esa celda — el resto de cambios se guarda igualmente. Los guardados muy grandes se ejecutan como tarea en segundo plano.",
            "Las columnas de selección (estado o sujeto a impuestos, por ejemplo) solo aceptan sus valores permitidos. Un valor pegado como «Sí» en una columna de estado se rechaza y se indica, en lugar de escribir algo incorrecto.",
          ],
        },
      ],
      tips: [
        "Las celdas que necesitan un selector (categoría de producto o pertenencia a colecciones, por ejemplo) son de solo lectura en el editor masivo. La ayuda emergente te lleva al editor individual.",
      ],
    },

    "bulk-csv": {
      title: "Exportar e importar CSV",
      summary: "Descargar el catálogo como hoja de cálculo, editarlo fuera y volver a cargarlo.",
      sections: [
        {
          heading: "Exportar",
          paragraphs: [
            "La exportación escribe la selección y las columnas actuales del editor masivo en un archivo CSV — todas las páginas del filtro, no solo la visible. Funciona con Excel, Numbers o Google Sheets.",
          ],
        },
        {
          heading: "Importar",
          paragraphs: [
            "Al importar, la app carga tu archivo, lo compara con el estado actual y muestra solo las celdas que difieren. Revisas los cambios en el editor y los guardas como cualquier otra edición — con las mismas comprobaciones por celda.",
          ],
        },
      ],
      tips: ["La primera columna contiene el identificador de cada fila. Déjala sin cambios, o la app no podrá asignar la fila."],
    },

    "bulk-translate": {
      title: "Completar las traducciones que faltan",
      summary: "Traducir todo lo que aún está vacío en un idioma, en todo el filtro actual.",
      sections: [
        {
          heading: "Cómo funciona",
          paragraphs: [],
          steps: [
            "En el editor masivo, filtra las filas que quieres traducir.",
            "Abre «Añadir traducciones que faltan».",
            "Elige arriba los idiomas de destino y marca o desmarca entradas o campos concretos en la lista.",
            "Inicia — la traducción se ejecuta como tarea en segundo plano.",
          ],
        },
        {
          heading: "Qué ocurre",
          paragraphs: [
            "Solo se rellenan las traducciones vacías; una traducción existente nunca se sobrescribe. La app vuelve a comprobar justo antes de escribir qué falta realmente. Los handles traducidos son opcionales y se normalizan a una forma de URL válida.",
          ],
        },
      ],
    },

    "image-manager": {
      title: "El Image Variant Manager",
      summary: "Cada variante con sus propias imágenes: crea galerías por variante, ordénalas y muéstralas en tu tienda.",
      sections: [
        {
          heading: "De qué se trata",
          paragraphs: [
            "Shopify solo conoce una imagen por variante. El Image Variant Manager da a cada variante su propia galería — quien elige «Rojo» solo ve las imágenes rojas. En la página de producto de la app sustituye a la gestión de imágenes estándar.",
          ],
        },
        {
          heading: "Crear galerías",
          paragraphs: [
            "Arriba está la galería del producto y debajo una galería por variante. Arrastra imágenes desde la galería del producto o desde tu biblioteca de archivos de Shopify a una variante, ordénalas arrastrando y cópialas o muévelas entre variantes. También se admiten vídeos, enlaces de YouTube/Vimeo y modelos 3D.",
          ],
        },
        {
          heading: "Mostrarlas en la tienda",
          paragraphs: [
            "Para que los visitantes vean las galerías por variante, activa el app embed «Galería de variantes» en el editor de temas. Adopta los ajustes de la galería de tu tema. Si aparecen dos galerías superpuestas, introduce en el embed el selector CSS de la galería de tu tema.",
          ],
        },
      ],
      tips: ["El Image Variant Manager, la subida masiva y la conversión a WebP están incluidos desde el plan Pro."],
    },

    "image-bulk-upload": {
      title: "Subida masiva con asignación por nombre de archivo",
      summary: "Sube todas las imágenes de un producto a la vez — el nombre del archivo decide a qué variante pertenece cada una.",
      sections: [
        {
          heading: "El esquema de nombres",
          paragraphs: [
            "Nombra los archivos según el patrón NombreProducto_Variante1_Variante2_Identificador.jpg, por ejemplo camiseta_rojo_M_01.jpg. Las partes entre el primer y el último guion bajo son los valores de opción de la variante; la última parte distingue varias imágenes de la misma variante.",
          ],
        },
        {
          heading: "Subir",
          paragraphs: [],
          steps: [
            "Abre la subida masiva en el Image Variant Manager.",
            "Arrastra todos los archivos a la vez.",
            "Revisa la asignación propuesta — los archivos no reconocidos se marcan.",
            "Guarda. Las imágenes se suben y se asignan a las galerías de variantes.",
          ],
        },
      ],
      tips: ["Si un archivo no se puede subir, se nombra en un aviso y no se añade — vuelve a subirlo después.", "La asignación se hace al subir. Cambiar después el nombre de los archivos no la altera."],
    },

    "alt-texts": {
      title: "Textos alternativos",
      summary: "Descripciones de imagen para Google y lectores de pantalla — generadas, con plantilla o a mano, y traducidas.",
      sections: [
        {
          heading: "Dónde están",
          paragraphs: [
            "Editas los textos alternativos en la imagen dentro del Image Variant Manager, en el editor para las imágenes de colecciones y artículos, y en bloque en el editor masivo, donde cada fila del tipo Imágenes es una imagen — tanto de productos como de tu biblioteca de archivos.",
            "Un texto alternativo del Image Variant Manager no se guarda al salir del campo: sigue siendo un borrador hasta que pulsas «Guardar» arriba, como cualquier otro cambio de la página. «Descartar» lo deshace. Si el guardado de una imagen falla, el cuadro de información indica el motivo, tu texto se queda en el campo y se vuelve a enviar con el siguiente «Guardar». Si cambias de idioma, de mercado o de producto con textos alternativos sin guardar, la app pregunta antes.",
          ],
        },
        {
          heading: "Con IA",
          paragraphs: [
            "La IA escribe un texto alternativo por imagen. El resultado queda como borrador en el campo y solo se aplica con «Guardar»; «Traducir a todos los idiomas», en cambio, escribe de inmediato en los otros idiomas. Con el envío de imágenes activado ve exactamente esa imagen — y no describe otra que simplemente esté al lado.",
          ],
        },
        {
          heading: "Con plantillas",
          paragraphs: [
            "Las plantillas de texto alternativo definen un texto por posición de imagen e idioma, como «Elegante maceta de cerámica {Color}» para la imagen principal, y lo aplican a todas las variantes de una vez.",
          ],
        },
        {
          heading: "Traducir",
          paragraphs: [
            "Los textos alternativos se traducen a todos los idiomas como cualquier otro campo y se actualizan con las mismas reglas cuando cambia el original. Con un mercado seleccionado en el editor, el gestor de imágenes muestra los textos alternativos de ese mercado (el del idioma si el mercado no tiene uno propio) y guarda los cambios solo para ese mercado. «Traducir a todos los idiomas» escribe siempre el texto del propio idioma, que también usan los mercados sin texto propio.",
          ],
        },
      ],
    },

    webp: {
      title: "Conversión a WebP",
      summary: "Convierte imágenes al formato compacto WebP — páginas más rápidas sin pérdida visible de calidad.",
      sections: [
        {
          heading: "Por qué WebP",
          paragraphs: [
            "Con la misma calidad visual, los archivos WebP suelen ser mucho más pequeños que JPEG o PNG. Las imágenes más ligeras cargan antes, y la imagen más grande de una página suele decidir su tiempo de carga medido.",
          ],
        },
        {
          heading: "Cómo funciona",
          paragraphs: [
            "En el Image Variant Manager seleccionas imágenes e inicias la conversión. Se ejecuta en segundo plano; la imagen convertida sustituye a la original allí donde se use, conservando su asignación a variantes y su texto alternativo.",
          ],
        },
      ],
      tips: ["Las subidas y conversiones cuentan contra un cupo mensual de tu plan; el uso aparece en Ajustes → Plan."],
    },

    keywords: {
      title: "Biblioteca y asignación de palabras clave",
      summary: "Reunir e investigar palabras clave y repartirlas entre productos, colecciones, páginas y artículos — por idioma.",
      sections: [
        {
          heading: "La biblioteca",
          paragraphs: [
            "En SEO → Palabras clave reúnes términos de búsqueda en grupos, como «juguetes de madera». Los añades tú o pides sugerencias. Cada idioma tiene sus propias palabras clave — lo que se busca en alemán es otra palabra en francés.",
          ],
        },
        {
          heading: "Repartir",
          paragraphs: [
            "«Repartir entre contenidos» asigna las palabras clave de un grupo al contenido adecuado. En modo IA, la IA elige por entrada una palabra clave principal y varias secundarias; en modo manual decides tú. Se admiten hasta cinco por entrada e idioma.",
          ],
        },
        {
          heading: "Usarlas",
          paragraphs: [
            "Las palabras clave asignadas aparecen en la barra lateral del editor. La puntuación SEO comprueba si aparecen en el título, la descripción y los textos meta, y la IA las tiene en cuenta al generar y mejorar.",
          ],
        },
      ],
    },

    "seo-score": {
      title: "Puntuación SEO y legibilidad en el editor",
      summary: "Una puntuación en directo que reacciona mientras escribes — y avisos honestos sobre la legibilidad de tu texto.",
      sections: [
        {
          heading: "La puntuación",
          paragraphs: [
            "La barra lateral muestra un valor de 0 a 100 para la entrada actual. Valora título, descripción, título SEO, meta descripción, textos alternativos y el uso de tus palabras clave, y cambia mientras escribes — no hace falta guardar para ver el efecto. Cada carencia aparece por separado.",
          ],
        },
        {
          heading: "Legibilidad",
          paragraphs: [
            "Debajo hay un análisis de legibilidad propio: frases demasiado largas, párrafos demasiado largos, falta de subtítulos. Solo se da una puntuación para español, inglés y alemán, porque solo para ellos existen fórmulas validadas — en otros idiomas un número sería sencillamente incorrecto.",
          ],
        },
        {
          heading: "Resumen",
          paragraphs: [
            "SEO → Resumen muestra la distribución de puntuaciones en toda la tienda y los problemas más frecuentes — con acceso directo a la entrada afectada y la opción de corregirlos con IA.",
            "Cuando la IA corrige un texto en el idioma principal, la app trata sus traducciones igual que al guardar en el editor: según tu ajuste en Ajustes → Traducciones, las traducciones antiguas se eliminan o, con la traducción automática activada, se traducen de nuevo. La app también comprueba que Shopify haya guardado realmente el texto; si no, la entrada cuenta como fallida.",
          ],
        },
      ],
    },

    crawl: {
      title: "Rastreo del sitio e informe on-page",
      summary:
        "La app visita tu tienda como un buscador e informa de lo que llega — no solo de lo que hay en la base de datos.",
      sections: [
        {
          heading: "Paso 1: entrega",
          paragraphs: [
            "El rastreo recorre tu tienda página a página, en todos los idiomas. El primer informe muestra lo que no llega: páginas y enlaces rotos, errores del servidor, redirecciones, respuestas lentas — y, si quieres, enlaces externos rotos.",
          ],
        },
        {
          heading: "Paso 2: on-page e indexación",
          paragraphs: [
            "El segundo informe lee el mismo rastreo: ¿puede Google indexar una página (noindex, canonical)? ¿Tiene H1, meta descripción, contenido suficiente, imágenes con texto alternativo? ¿Hay títulos duplicados?",
            "Los informes filtran las falsas alarmas — páginas de políticas que técnicamente no admiten meta descripción, por ejemplo, o páginas que excluiste a propósito. Cuando un hallazgo pertenece a un contenido, un clic abre el editor correspondiente.",
          ],
        },
        {
          heading: "Cuándo",
          paragraphs: [
            "Inicias el rastreo con «Escanear ahora»; además se ejecuta automáticamente cada semana. Una comparación muestra qué ha cambiado desde la última vez. Todos los hallazgos se pueden exportar a CSV.",
          ],
        },
      ],
    },

    performance: {
      title: "Velocidad y calidad",
      summary: "Prueba páginas con Google PageSpeed Insights y consulta datos de usuarios reales de tu tienda.",
      sections: [
        {
          heading: "Medición de laboratorio",
          paragraphs: [
            "En SEO → Velocidad y calidad pruebas una página con Google PageSpeed Insights: Core Web Vitals como LCP, CLS e INP, más accesibilidad y buenas prácticas de la misma prueba. Cada valor explica qué mide y qué suele empeorarlo en las tiendas Shopify.",
          ],
        },
        {
          heading: "Visitantes reales",
          paragraphs: [
            "Con el app embed «Web Vitals», la app mide los valores de tus visitantes reales. Estos datos suelen diferir bastante de la medición de laboratorio y son los que valora Google. Con poco tráfico, pasan unos días hasta reunir mediciones suficientes.",
          ],
        },
      ],
      tips: [
        "La app diagnostica la velocidad pero nunca modifica el código de tu tema. Los avisos te dicen dónde está la causa — una app concreta o una imagen demasiado grande, por ejemplo.",
      ],
    },

    "search-console": {
      title: "Google Search Console",
      summary: "Clics, impresiones y posiciones reales de Google, dentro de la app.",
      sections: [
        {
          heading: "Conectar",
          paragraphs: [],
          steps: [
            "Abre SEO → Search Console.",
            "Inicia sesión con la cuenta de Google que tiene acceso a la propiedad de tu tienda.",
            "Elige la propiedad.",
          ],
        },
        {
          heading: "Qué ves",
          paragraphs: [
            "Para qué búsquedas aparecen tus páginas, cuántas veces se hace clic y en qué posición están — con historial y exportación. Así ves si tus palabras clave y textos funcionan y encuentras términos en los que casi posicionas bien.",
          ],
        },
      ],
      tips: ["La conexión con Search Console está incluida en los planes Pro y Max."],
    },

    redirects: {
      title: "Redirecciones y errores 404",
      summary: "Gestionar redirecciones 301, resolver cadenas de redirecciones y corregir errores 404 frecuentes.",
      sections: [
        {
          heading: "Gestionar redirecciones",
          paragraphs: [
            "En SEO → Redirecciones ves, buscas, creas y borras las redirecciones de tu tienda. La importación y la exportación usan dos columnas, ruta de origen y ruta de destino; la importación reconoce también exportaciones de Shopify, Yoast y Rank Math.",
          ],
        },
        {
          heading: "Cadenas",
          paragraphs: [
            "Si A redirige a B y B a C, cada visita da un rodeo. La app encuentra esas cadenas y bucles en tu lista de redirecciones y te permite apuntar A directamente a C.",
          ],
        },
        {
          heading: "Errores 404",
          paragraphs: [
            "Las direcciones que los visitantes solicitan y que no existen se recogen y se ordenan por frecuencia. Para cada una puedes crear directamente una redirección a la página correcta. Se registran en cuanto uno de los app embeds de la app está activo en tu tema.",
          ],
        },
      ],
    },

    "internal-links": {
      title: "Enlaces internos",
      summary: "Encuentra lugares donde mencionas productos o colecciones pero aún no los enlazas.",
      sections: [
        {
          heading: "Cómo funciona",
          paragraphs: [
            "La app busca en artículos del blog, páginas y descripciones de producto menciones de tus productos y colecciones que todavía no son un enlace. Cada hallazgo aparece como sugerencia con el fragmento de texto.",
          ],
        },
        {
          heading: "Aplicar",
          paragraphs: [
            "Antes de aceptar ves una vista previa del texto con el nuevo enlace; al confirmar, se inserta y se guarda en Shopify. Las sugerencias rechazadas no vuelven en rastreos posteriores. Los enlaces internos ayudan a los visitantes y muestran a los buscadores qué páginas van juntas.",
          ],
        },
      ],
    },

    "sitemap-indexnow": {
      title: "Sitemap e IndexNow",
      summary: "Controla qué hay en tu sitemap e informa a los buscadores de los cambios al instante.",
      sections: [
        {
          heading: "Sitemap",
          paragraphs: [
            "Shopify genera el sitemap.xml por sí mismo. En SEO → Sitemap ves qué contiene y recibes sugerencias sobre páginas que conviene excluir — páginas de agradecimiento o colecciones vacías, por ejemplo. Una exclusión establece el metacampo seo.hidden de Shopify y se puede deshacer en cualquier momento.",
          ],
        },
        {
          heading: "IndexNow",
          paragraphs: [
            "IndexNow avisa al instante a Bing y a otros buscadores cuando una página es nueva, cambia o se elimina, en lugar de esperar a la próxima visita del rastreador. La app configura la clave necesaria y comunica los cambios automáticamente — también cuando publicas u ocultas páginas en el editor masivo.",
          ],
        },
      ],
      tips: ["IndexNow está incluido en los planes Pro y Max."],
    },

    hreflang: {
      title: "Comprobación de hreflang",
      summary: "Para tiendas multilingües: comprueba si cada idioma publicado está realmente traducido.",
      sections: [
        {
          heading: "De qué se trata",
          paragraphs: [
            "Mediante hreflang, Shopify comunica a los buscadores que una página existe en cada idioma publicado. Si en alguno no está traducida, Google muestra allí el texto original bajo una dirección en otro idioma — confuso para los visitantes y débil para el posicionamiento.",
          ],
        },
        {
          heading: "El informe",
          paragraphs: [
            "En SEO → hreflang ves por idioma cuánto contenido está traducido del todo, en parte o nada, y saltas directamente a los huecos.",
          ],
        },
      ],
      tips: ["En una tienda de un solo idioma esta área aparece en gris, porque no hay nada que comprobar."],
    },

    "structured-data": {
      title: "Datos estructurados y vistas previas sociales",
      summary:
        "JSON-LD para resultados enriquecidos en Google y etiquetas Open Graph para los enlaces compartidos — y una comprobación de que nada está duplicado.",
      sections: [
        {
          heading: "Qué se entrega",
          paragraphs: [
            "El app embed «Datos estructurados» genera marcado schema.org para productos, colecciones, artículos, organización, migas de pan, preguntas frecuentes y vídeos. «Vistas previas sociales» añade etiquetas Open Graph y de Twitter para que un enlace compartido aparezca con imagen, título y descripción.",
          ],
        },
        {
          heading: "Primero medir, luego activar",
          paragraphs: [
            "Muchos temas ya generan su propio marcado, y el marcado duplicado produce errores en la prueba de Google. Por eso, en SEO → Datos estructurados la app lee el último rastreo y te dice por tipo si conviene activarlo, si ya lo entrega tu tema u otra app o si aún no hay medición. Los interruptores van al final.",
          ],
        },
        {
          heading: "Vídeos",
          paragraphs: [
            "Para los vídeos de producto, la app toma automáticamente la fecha de subida de Shopify. Para los enlaces de YouTube en galerías de variantes Shopify no conoce ninguna fecha; la comprobación enumera esos productos para que puedas indicarla.",
          ],
        },
      ],
    },

    "ai-discovery": {
      title: "agents.md y llms.txt",
      summary: "Los archivos que leen los asistentes de IA sobre tu tienda — generados a partir de tu catálogo y siempre al día.",
      sections: [
        {
          heading: "Qué son estos archivos",
          paragraphs: [
            "/agents.md y /llms.txt son archivos que leen los asistentes y rastreadores de IA para entender una tienda: quién eres, qué vendes, dónde están tus políticas. Shopify sirve una versión predeterminada; la app la sustituye por una generada a partir de tu catálogo.",
          ],
        },
        {
          heading: "Generar y comprobar",
          paragraphs: [
            "En SEO → Búsqueda con IA generas ambos archivos con un clic. El párrafo inicial lo escribes tú — con ayuda de la IA si quieres — y el resto se genera a partir de tus productos, colecciones y políticas. Después la app consulta la dirección real y muestra si de verdad se sirve tu versión.",
            "Si quieres, la app actualiza los archivos automáticamente cuando se quedan desfasados. «Quitar nuestra versión» devuelve la dirección a Shopify en cualquier momento.",
          ],
        },
        {
          heading: "robots.txt",
          paragraphs: [
            "La misma área comprueba si tu robots.txt bloquea a los rastreadores de IA — algunos temas y apps lo hacen sin que nadie se dé cuenta.",
          ],
        },
      ],
    },

    "catalog-readiness": {
      title: "Preparación del catálogo y visitas desde IA",
      summary: "Qué le falta a un producto antes de que los canales de IA lo recojan — y cuántos visitantes llegan desde asistentes de IA.",
      sections: [
        {
          heading: "Preparación del catálogo",
          paragraphs: [
            "Shopify pasa automáticamente los productos aptos a los canales de IA. Que un producto sea apto depende de lo completo que esté. La app revisa cinco datos en todos los productos activos — marca, categoría, GTIN/código de barras, descripción e imagen — y enumera lo que falta.",
          ],
        },
        {
          heading: "Visitas desde asistentes de IA",
          paragraphs: [
            "Con el embed Web Vitals activado, la app cuenta las visitas que llegan desde ChatGPT, Perplexity, Gemini, Copilot y otros asistentes — sin cookies y sin datos personales, por día y página de destino.",
            "Hay dos límites: los clics desde Google AI Overviews parecen visitas normales de Google, y Claude no transmite ningún origen. Ninguno de los dos se cuenta — mejor de menos que mal.",
          ],
        },
      ],
    },

    "product-details": {
      title: "Detalles de producto, precios e inventario",
      summary:
        "Proveedor, etiquetas, categoría, colecciones, precios, inventario y canales de venta — junto a los textos.",
      sections: [
        {
          heading: "Merchandising",
          paragraphs: [
            "En el área Detalles del editor de productos editas proveedor, tipo de producto, etiquetas, la categoría de producto de Shopify, la pertenencia a colecciones, la plantilla del tema y el estado. La plantilla se elige entre las que existen realmente en tu tema publicado.",
          ],
        },
        {
          heading: "Precios, envío e inventario",
          paragraphs: [
            "Para cada variante: precio, precio de comparación, coste, SKU, código de barras, peso y datos aduaneros. La app lee el inventario en directo de Shopify y solo lo escribe si el valor no ha cambiado desde que se cargó — así un pedido realizado entretanto nunca se sobrescribe.",
          ],
        },
        {
          heading: "Traducir opciones",
          paragraphs: [
            "Debajo de cada opción en la sección de variantes — también cuando está plegada — «Traducir» traduce el nombre de la opción y sus valores a todos los idiomas, y «Copiar a todos los idiomas» los copia sin cambios. En una opción abierta, los dos botones están entre «Eliminar» y «Hecho». Una opción con fondo azul aún no tiene traducción en al menos un idioma. Si has cambiado una opción, guarda primero: los botones permanecen bloqueados hasta que el cambio se guarda, para que nunca se traduzca el texto anterior.",
          ],
        },
        {
          heading: "Visibilidad",
          paragraphs: [
            "Un producto activo no es automáticamente visible: también tiene que estar publicado en un canal de venta. La app muestra en qué canales, regiones y catálogos B2B aparece un producto.",
          ],
        },
      ],
    },

    "collection-rules": {
      title: "Colecciones y sus reglas",
      summary: "Colecciones manuales y automáticas, el editor de reglas y el orden.",
      sections: [
        {
          heading: "Dos tipos",
          paragraphs: [
            "Las colecciones manuales contienen los productos que añades. Las automáticas deciden sus miembros mediante reglas como «la etiqueta es rebajas» o «precio inferior a 50». Los miembros de una colección automática se muestran en la app pero no se pueden cambiar a mano — Shopify lo rechazaría o lo desharía al instante.",
          ],
        },
        {
          heading: "El editor de reglas",
          paragraphs: [
            "En el editor de colecciones editas las condiciones de una colección automática: etiqueta, tipo de producto, proveedor, precio, categoría, metacampos y más, con condiciones de inclusión y exclusión. Las condiciones que la app no puede representar sin pérdidas quedan en solo lectura, para que nada cambie por accidente.",
          ],
        },
        {
          heading: "Orden",
          paragraphs: [
            "El orden define la secuencia de los productos en la tienda. «Manual» es el orden que fijas en el panel de Shopify; cualquier otro valor ordena automáticamente.",
          ],
        },
      ],
    },

    "store-texts": {
      title: "Políticas, textos del checkout y del sistema",
      summary: "Los textos fuera del catálogo: políticas, notificaciones, métodos de envío, filtros, planes de suscripción y más.",
      sections: [
        {
          heading: "Qué incluye",
          paragraphs: ["Además del catálogo, en Contenido encontrarás:"],
          list: [
            "Políticas — devoluciones, privacidad, condiciones, envíos.",
            "Notificaciones — plantillas de correo, textos de pago y otros textos del sistema de Shopify.",
            "Envío y entrega — los nombres de los métodos de envío tal como aparecen en el checkout.",
            "Filtros — las etiquetas de los filtros de la tienda.",
            "Planes de suscripción — nombres y descripciones de tus opciones de suscripción.",
            "Metadatos de la tienda — el nombre y la descripción de la tienda.",
            "Banner de cookies — los textos de tu banner de consentimiento, en cuanto Shopify lo abra a las apps.",
          ],
        },
        {
          heading: "Editar y traducir",
          paragraphs: [
            "Editas y traduces estos textos en el editor habitual. Algunos los gestiona Shopify directamente: en ellos el idioma principal es de solo lectura y se mantiene en el panel de Shopify, mientras que las traducciones se hacen en la app.",
          ],
        },
      ],
    },
  },
};
