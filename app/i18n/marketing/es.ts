import type { MarketingTranslation } from "./en";

export const es: MarketingTranslation = {
  site: {
    name: "ContentPilot AI",
    tagline: "Textos con IA, SEO y traducciones para Shopify — en un solo lugar.",
    description:
      "Escriba, optimice y traduzca cada texto de su tienda Shopify: productos, colecciones, páginas, blogs, menús, metaobjetos y contenido del tema. Hecho para tiendas que venden en más de un idioma.",
  },

  nav: {
    features: "Funciones",
    pricing: "Precios",
    roadmap: "Hoja de ruta",
    faq: "Preguntas",
    guide: "Guía",
    compare: "Comparativa",
    install: "Instalar en Shopify",
    installShort: "Instalar",
    menu: "Menú",
    language: "Idioma",
  },

  hero: {
    storeBadge: "Disponible en la Shopify App Store",
    eyebrow: "Aplicación de Shopify",
    title: "Cada texto de su tienda. Escrito, encontrado y traducido.",
    subtitle:
      "ContentPilot AI redacta textos de producto, pone en orden su SEO y mantiene cada traducción unida al texto del que nació — en todos sus idiomas y mercados.",
    ctaPrimary: "Ver lo que hace",
    note: "Funciona con su tema actual. Nunca modifica el código de su tema.",
  },

  pillars: {
    more: "Ver todas las funciones",
    compare: "Comparar con otras apps de traducción",
    title: "Tres cosas que hace bien",
    items: [
      {
        title: "Escribe",
        body: "Títulos, descripciones, metatextos y textos alternativos — para productos, colecciones, páginas, blogs, artículos, metaobjetos y contenido del tema. Usted elige el proveedor de IA y el tono; la aplicación aporta el contexto de su propio catálogo.",
      },
      {
        title: "Traduce",
        body: "Todos los idiomas publicados y todos los mercados. Una traducción solo cuenta como guardada cuando Shopify la devuelve confirmada, y cuando cambia un texto de origen la traducción se rehace en lugar de describir en silencio un texto que ya no existe.",
      },
      {
        title: "Hace que le encuentren",
        body: "Un rastreo de su propia tienda, un informe on-page, datos estructurados, cadenas de redirección, control del sitemap, IndexNow — y la parte más nueva que casi nadie cubre: lo que leen los asistentes de IA cuando alguien les pregunta por su tienda.",
      },
    ],
  },

  features: {
    guideLink: "Cómo funciona — ver la guía",
    compareLink: "¿Cómo se compara con Translate & Adapt, Weglot y otras?",
    title: "Funciones",
    intro:
      "La aplicación es un conjunto de herramientas con algo en común: todas trabajan sobre el texto del que está hecha su tienda. Esto es lo que incluye.",
    groups: [
      {
        id: "ai",
        title: "Redacción con IA",
        body: "Genere o mejore cualquier campo, uno a uno o para toda la tienda. El prompt lleva sus propias instrucciones, su glosario y — si lo permite — la propia imagen del producto.",
        points: [
          "Seis proveedores a elegir: Anthropic, OpenAI, Gemini, DeepSeek, Grok, HuggingFace",
          "Instrucciones propias por campo y un glosario para toda la tienda",
          "Comprensión de imágenes opcional, para que un texto alternativo describa la imagen real",
          "Las sugerencias llegan al campo y esperan su aprobación — nada se escribe a sus espaldas",
        ],
      },
      {
        id: "translations",
        title: "Traducciones y mercados",
        body: "La parte que la mayoría de aplicaciones hace mal. Shopify guarda una traducción por idioma y, además, por mercado — alemán para Suiza redactado de otra forma que alemán para Alemania. Se tratan ambas capas.",
        points: [
          "Todos los idiomas publicados, más las variantes específicas de cada mercado",
          "Solo está guardado lo que Shopify confirma de vuelta — sin fallos silenciosos",
          "Cambie un texto de origen y la traducción se rehace en lugar de quedar obsoleta",
          "Rellene lo que falta en todo el catálogo en una sola pasada",
          "Handles de URL traducidos, con la redirección 301 que les corresponde",
        ],
      },
      {
        id: "bulk",
        title: "Editor masivo",
        body: "Una hoja de cálculo sobre toda la tienda — productos, variantes, colecciones, artículos, páginas, blogs, políticas, metaobjetos e imágenes — en la que solo se escriben las celdas que usted ha tocado.",
        points: [
          "Filtre, ordene y edite cientos de filas a la vez",
          "Exportación e importación de CSV",
          "Los errores son por celda: un campo rechazado nunca se lleva el resto de su trabajo",
          "Una pasada que añade las traducciones que faltan en la selección actual",
        ],
      },
      {
        id: "seo",
        title: "SEO",
        body: "Un rastreo de su propia tienda en lugar de una suposición desde la base de datos, y un informe que filtra sus propios falsos positivos.",
        points: [
          "Informe on-page: títulos, metadescripciones, encabezados, contenido escaso, duplicados",
          "Enlaces internos y externos rotos",
          "Cadenas de redirección, deducidas de su propia lista de redirecciones",
          "Indexabilidad: qué queda fuera de la búsqueda y si alguien lo quiso así",
          "Control del sitemap y envíos a IndexNow",
          "Auditoría de hreflang para tiendas multilingües",
        ],
      },
      {
        id: "aeo",
        title: "Optimización para motores de respuesta",
        body: "Buscar ya no es solo buscar. Esta parte trata de lo que lee un asistente de IA cuando un cliente le pregunta por sus productos.",
        points: [
          "agents.md y llms.txt, generados desde su catálogo y mantenidos al día",
          "Datos estructurados (JSON-LD) para productos, artículos, preguntas frecuentes, vídeos y más",
          "Open Graph y Twitter Cards, medidos contra lo que su tienda sirve de verdad",
          "Preparación del catálogo: qué falta antes de que los canales de IA recojan un producto",
          "Visitas llegadas desde un asistente de IA, contadas sin cookies",
        ],
      },
      {
        id: "media",
        title: "Imágenes y medios",
        body: "Los textos alternativos también son contenido, y son el texto que nadie escribe.",
        points: [
          "Textos alternativos con IA para medios de producto, imágenes de colección y de artículo",
          "Textos alternativos traducidos a cada idioma como cualquier otro campo",
          "Carga masiva con asignación a variantes a partir del nombre de archivo",
          "Conversión a WebP, orden de la galería, vídeos y modelos 3D",
        ],
      },
      {
        id: "structure",
        title: "Navegación, metaobjetos, textos del tema",
        body: "El contenido que no es un producto, donde la mayoría de herramientas se detiene.",
        points: [
          "Editor de menús completo: renombrar, reordenar, anidar, reapuntar — conservando las traducciones",
          "Entradas de metaobjetos y sus campos, traducidos",
          "Textos y ajustes del tema, por tema y por mercado",
          "Políticas de la tienda, páginas, blogs y artículos",
        ],
      },
    ],
  },

  pricing: {
    title: "Planes y precios",
    intro:
      "Cuatro planes que se diferencian en cuánto de su tienda cubren, no en cuántos idiomas puede usar. Todos los planes traducen a todos sus idiomas.",
    trial: "Cada plan de pago empieza con {days} días de prueba gratuita. Facturado por Shopify, cancelable en cualquier momento.",
    modeLabel: "Cómo se paga la IA",
    modeOwnKey: "Con su propia clave de IA",
    modeIncluded: "IA incluida",
    modeOwnKeyHint:
      "Conecta su propia clave de OpenAI, Anthropic, Gemini, DeepSeek, Grok o HuggingFace y paga directamente al proveedor por lo que usa.",
    modeIncludedHint:
      "Sin clave y sin segunda factura: un volumen mensual de IA forma parte del precio. Aun así puede conectar su propia clave cuando quiera.",
    free: "Gratis",
    perMonth: "/ mes",
    recommended: "El más elegido",
    choose: "Instalar y elegir este plan",
    chooseFree: "Instalar gratis",
    limitsLine: "{products} productos · {collections} colecciones",
    everythingIn: "Todo lo de {plan}, y además:",
    included: "Incluido:",
    tasterLine: "Unas {taster} acciones de IA una sola vez para probar, sin clave",
    moreInTable: "+ {n} más en la tabla de abajo",
    plans: {
      free: {
        tagline: "Para probarla con un catálogo pequeño.",
      },
      basic: {
        tagline: "Para tiendas pequeñas.",
      },
      pro: {
        tagline: "Para tiendas en crecimiento.",
      },
      max: {
        tagline: "Para catálogos grandes.",
      },
    },
    includedVolume: {
      free: "Incluye una sola vez unas {taster} acciones de IA para probar",
      basic: "IA incluida: unos 300–500 productos al mes, cada uno traducido a un idioma",
      pro: "IA incluida: unos 600–1.000 productos al mes, cada uno traducido a un idioma",
      max: "IA incluida: unos 1.500–2.500 productos al mes, cada uno traducido a un idioma",
    },
    tableTitle: "Comparar los planes",
    tableIntro: "Todo lo que contiene cada plan, fila por fila. Las cifras son por tienda.",
    planColumn: "Función",
    priceRow: "Precio",
    groups: {
      content: "Contenido que puede editar y traducir",
      workflow: "Traducción e IA",
      images: "Imágenes",
      seo: "SEO y visibilidad en IA",
    },
    rows: {
      products: { label: "Productos", help: "Productos que la app carga y edita." },
      collections: { label: "Colecciones" },
      pages: { label: "Páginas" },
      articles: { label: "Blogs y artículos", help: "Número de artículos." },
      policies: { label: "Políticas de la tienda", help: "Reembolso, privacidad, envío y términos." },
      menus: { label: "Menús de navegación", help: "Editar y traducir sus menús." },
      metaobjects: { label: "Metaobjetos" },
      themeTranslations: { label: "Textos del tema", help: "Textos y ajustes de su tema, traducidos." },
      checkoutTexts: { label: "Textos de envío y checkout" },
      notifications: { label: "Notificaciones y albaranes", help: "Los correos y documentos que envía Shopify." },
      directTranslations: { label: "Traducciones directas", help: "Traducir cualquier texto que aparezca en su tienda." },
      languages: { label: "Idiomas" },
      ownKey: { label: "Su propia clave de IA", help: "Seis proveedores a elegir." },
      aiInstructions: { label: "Instrucciones de IA propias", help: "Tono y reglas por campo, usados en cada prompt." },
      bulkEditor: { label: "Editor masivo y exportación CSV", help: "Una hoja de cálculo sobre toda su tienda." },
      csvImport: { label: "Importación CSV" },
      translateMissing: { label: "Añadir todas las traducciones que faltan de una vez" },
      autoTranslate: { label: "Traducción automática", help: "Cuando cambia un texto — en la app o en el admin de Shopify — sus traducciones se renuevan." },
      productImages: { label: "Imágenes de producto" },
      imageSuite: { label: "Gestor de imágenes", help: "Galerías por variante, subida masiva, textos alternativos en serie, nombres por SKU." },
      imageOperations: { label: "Subidas de imágenes y conversiones WebP" },
      seoAudit: { label: "Auditoría SEO, datos estructurados, redirecciones, hreflang" },
      pageSpeed: { label: "Mediciones de PageSpeed" },
      keywords: { label: "Palabras clave seguidas" },
      aiDiscovery: { label: "Descubrimiento por IA (agents.md, llms.txt)", help: "Lo que leen los asistentes de IA sobre su tienda." },
      crawl: { label: "Rastreo de la tienda e informe on-page" },
      searchConsole: { label: "Google Search Console" },
      internalLinks: { label: "Sugerencias de enlaces internos" },
      sitemap: { label: "Control del sitemap" },
      indexNow: { label: "Envíos a IndexNow" },
      scoreHistory: { label: "Historial de la puntuación SEO" },
      scheduled: { label: "Auditoría nocturna y rastreo semanal automáticos" },
      seoBulk: { label: "Elementos por corrección SEO masiva" },
    },
    formats: {
      imageOperations: "{n} / mes",
      pageSpeed: "{n} / día",
      searchConsole: "{n} días de datos",
      indexNow: "{n} / mes",
      scoreHistory: "{n} días",
    },
    values: {
      yes: "Incluido",
      no: "No incluido",
      unlimited: "Ilimitado",
      featuredOnly: "Imagen principal",
      allImages: "Todas las imágenes",
    },
    tableNote:
      "Los límites se aplican a lo que la app edita. Su tienda puede ser más grande: el contenido por encima del límite simplemente se queda como está.",
    compareLink: "¿Cómo se comparan estos precios con otras apps?",
    faqTitle: "Preguntas sobre la facturación",
    faq: [
      {
        q: "¿Cómo se factura la app?",
        a: "En su factura normal de Shopify, en euros. No hay una cuenta aparte ni una tarjeta de crédito que introducir en este sitio.",
      },
      {
        q: "¿Hay una prueba gratuita?",
        a: "Sí. Cada plan de pago empieza con {days} días de prueba, y el plan gratuito no tiene límite de tiempo. Si cancela durante la prueba, no paga nada.",
      },
      {
        q: "¿Puedo cambiar de plan más adelante?",
        a: "Sí, en cualquier momento, en los ajustes de la app. Shopify ajusta el cobro por usted. Bajar de plan nunca borra contenido de su tienda Shopify.",
      },
      {
        q: "¿Clave propia o IA incluida? ¿Qué elijo?",
        a: "Con su propia clave paga directamente al proveedor de IA por lo que usa y elige el modelo. Con la IA incluida no hay nada que configurar y una sola factura para todo. Ambas opciones tienen las mismas funciones.",
      },
      {
        q: "¿Cuestan más idiomas más dinero?",
        a: "No. Todos los planes incluyen todos sus idiomas. Los planes se diferencian en el número de productos y en los tipos de contenido que cubren.",
      },
    ],
  },

  media: {
    placeholder: "Imagen pendiente",
    alt: {
      "feature-ai": "Un campo con un texto generado y el botón de aceptar al lado",
      "feature-translations": "La página 'añadir traducciones que faltan' con las casillas por idioma",
      "feature-bulk": "La cuadrícula del editor masivo con un filtro aplicado y unas celdas editadas resaltadas",
      "feature-seo": "El informe de rastreo: enlaces rotos, cadenas de redirección e indexabilidad en una vista",
      "feature-aeo": "La sección de descubrimiento para IA con agents.md, llms.txt y el estado de los datos estructurados",
      "feature-media": "El gestor de imágenes con textos alternativos en varios idiomas",
      "feature-structure": "El editor de menús con un árbol de navegación anidado",
    },
  },

  guide: {
    title: "Guía",
    intro:
      "Cómo funciona cada parte de la app, tema a tema. Cada tema explica qué hace la función y cómo usarla; estamos grabando un vídeo corto para cada uno.",
    topicCount: "{count} temas",
    videoBadge: "Vídeo",
    videoPendingBadge: "Vídeo próximamente",
    videoPending: "Vídeo próximamente",
    videoPendingBody: "Estamos grabando el vídeo de este tema. Mientras tanto, el texto de abajo lo explica todo.",
    tips: "Conviene saber",
    inThisCategory: "En esta categoría",
    allTopics: "Todos los temas",
    previous: "Anterior",
    next: "Siguiente",
    helpTitle: "¿Sigues con dudas?",
    helpBody: "Escríbenos — respondemos a todas las preguntas, y las buenas acaban en esta guía.",
    helpAction: "Contactar con soporte",
  },

  /** Labels of the click-to-load video player the guide (and the home page) use. */
  video: {
    pending: "Vídeo próximamente",
    heroTitle: "ContentPilot de un vistazo",
    loadExternal: "Cargar y reproducir",
    externalNote:
      "Al reproducirlo, el vídeo se carga desde un proveedor externo que puede usar cookies.",
  },

  install: {
    title: "Instalar en Shopify",
    intro:
      "Introduzca la dirección de Shopify de su tienda. Llegará a la pantalla de permisos de Shopify, donde usted decide qué puede leer y escribir la aplicación — no se instala nada antes de que lo apruebe allí.",
    label: "Su tienda Shopify",
    placeholder: "mi-tienda.myshopify.com",
    help: "La dirección .myshopify.com, solo el nombre de la tienda, o la URL del panel que tenga abierta — las tres funcionan.",
    submit: "Continuar a Shopify",
    errors: {
      empty: "Introduzca la dirección de su tienda.",
      invalid: "Eso no parece una dirección de tienda Shopify. Use mi-tienda.myshopify.com, o simplemente el nombre de la tienda.",
      customDomain:
        "Esa es su dominio de tienda. La instalación se hace desde la dirección .myshopify.com de la tienda — la encontrará en el panel de Shopify en Configuración, o en la URL como admin.shopify.com/store/<nombre>.",
    },
  },

  roadmap: {
    title: "Hoja de ruta",
    intro:
      "Qué viene después, qué se está sopesando y qué solo se construye cuando alguien lo pide. El orden dentro de cada sección es la prioridad; no hay fechas, porque una fecha pública que se retrasa se lee como una promesa rota.",
    note: "Esta página se genera desde el mismo archivo en el que vive el plan de desarrollo — cuando allí cambia un estado, cambia aquí.",
    sections: {
      inProgress: "En curso",
      planned: "A continuación",
      considering: "En estudio",
      onRequest: "Solo a petición",
      shipped: "Entregado recientemente",
    },
    shippedOn: "Entregado",
    areas: {
      ai: "Redacción con IA",
      translations: "Traducciones",
      bulk: "Editor masivo",
      seo: "SEO",
      aeo: "Descubrimiento por IA",
      media: "Imágenes y medios",
      ads: "Publicidad",
      structure: "Estructura",
      platform: "Plataforma",
      website: "Esta web",
    },
  },

  faq: {
    title: "Preguntas",
    items: [
      {
        q: "¿Modifica mi tema?",
        a: "No. La aplicación nunca edita el código de su tema — sin marcado inyectado, sin secciones reescritas, sin retoques de rendimiento en archivos que usted escribió. Los únicos archivos de tema que toca son los que ella misma creó (sus archivos de descubrimiento para IA y sus propios bloques de tienda), y puede devolver cada uno de ellos.",
      },
      {
        q: "¿Qué proveedor de IA usa?",
        a: "El que usted conecte: Anthropic, OpenAI, Gemini, DeepSeek, Grok o HuggingFace. Con su propia clave, el coste y la elección del modelo siguen siendo suyos. Si prefiere no configurar una clave, cada plan de pago está disponible también con la IA incluida.",
      },
      {
        q: "¿Necesito más de un idioma?",
        a: "No. La redacción, el SEO y las imágenes funcionan en una tienda de un solo idioma, y la interfaz de traducción sencillamente no aparece. La aplicación da lo mejor de sí en una tienda multilingüe, que es para lo que se construyó la mayor parte.",
      },
      {
        q: "¿Qué pasa con mis traducciones si edito el texto original?",
        a: "Esa es la pregunta para la que existe esta aplicación. Una traducción de un texto que ya no existe es peor que ninguna, así que un texto de origen modificado hace que sus traducciones se rehagan o se eliminen. Cuál de las dos cosas ocurre es un ajuste suyo, no un valor por defecto oculto.",
      },
      {
        q: "¿Se envían los datos de mi tienda al proveedor de IA?",
        a: "Solo el texto del campo que se está escribiendo, más el contexto necesario para escribirlo, y solo cuando usted pide una generación. Que la IA pueda mirar sus imágenes de producto es un único ajuste para toda la tienda, desactivado mientras usted no lo active.",
      },
      {
        q: "¿Funciona fuera del panel de Shopify?",
        a: "Esta web sí. La aplicación en sí vive dentro de su panel de Shopify, que es donde está su contenido.",
      },
    ],
  },

  cta: {
    title: "Véalo en su propia tienda",
    body: "La aplicación se instala en su panel de Shopify y lee su catálogo. No se escribe nada hasta que usted guarda.",
    button: "Instalar en Shopify",
  },

  footer: {
    tagline: "Textos con IA, SEO y traducciones para Shopify.",
    product: "Producto",
    legal: "Legal",
    privacy: "Privacidad",
    terms: "Términos",
    support: "Soporte",
    contact: "Contacto",
    rights: "Todos los derechos reservados.",
  },

  languageHint: {
    text: "Esta página también está disponible en {language}.",
    action: "Cambiar",
    dismiss: "Cerrar",
  },

  error: {
    title: "Algo ha salido mal",
    body: "Esta página no se ha podido mostrar. Inténtelo de nuevo en un momento.",
  },

  notFound: {
    title: "Página no encontrada",
    body: "Esa dirección no existe en este sitio.",
    action: "Volver al inicio",
  },
};
