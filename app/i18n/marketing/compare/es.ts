import type { CompareCopy } from "./types";

export const compareEs: CompareCopy = {
  title: "ContentPilot frente a otras apps de traducción para Shopify",
  intro:
    "Cómo se compara ContentPilot AI con Translate & Adapt, Weglot, Transcy, LangShop, T Lab, Langify y GTranslate: qué hace bien cada app, en qué se diferencian y cuál encaja con cada tienda.",
  vsTitle: "ContentPilot vs. {name}",
  vsMetaTitle: "ContentPilot vs. {name}: apps de traducción para Shopify comparadas",
  tableHeading: "Función por función",
  featureColumn: "Función",
  support: {
    yes: "Sí",
    partial: "En parte",
    no: "No",
    unstated: "Sin datos",
    higherPlan: "Plan superior",
  },
  groups: {
    translation: "Traducción",
    content: "Contenido",
    seo: "SEO y búsqueda con IA",
    media: "Imágenes",
    international: "Vender en el extranjero",
    seoBasics: "Lo básico",
    seoTechnical: "Técnica y rastreo",
    seoSearch: "Google y palabras clave",
    aiSearch: "Búsqueda con IA",
    aiEngine: "IA y control",
    aiTexts: "Textos",
    aiWorkflow: "Forma de trabajar",
    gallery: "Galería",
    assignment: "Asignar imágenes",
    swatches: "Muestras y listados",
    imageExtras: "Extras de imagen",
  },
  rows: {
    autoTranslate: {
      label: "Traducción automática",
      help: "Los textos se traducen con máquina o IA en lugar de a mano.",
    },
    nativeStorage: {
      label: "Traducciones guardadas en Shopify",
      help: "Las traducciones están en su tienda, no en los servidores del proveedor. Se conservan si desinstala la app.",
    },
    brandVoice: {
      label: "Instrucciones propias para la IA",
      help: "El tono, las palabras y las reglas que usted define se aplican a cada traducción.",
    },
    aiProvider: {
      label: "Elección del proveedor de IA",
      help: "Usted decide qué IA hace el trabajo.",
    },
    glossary: {
      label: "Glosario",
      help: "Los nombres de marca y términos fijos se traducen siempre igual, o no se traducen.",
    },
    themeCheckout: {
      label: "Tema, checkout y correos",
      help: "Botones, textos del checkout y correos de notificación, no solo productos.",
    },
    thirdPartyApps: {
      label: "Textos de otras apps",
      help: "Widgets de reseñas, popups y otros textos de apps en su tienda.",
    },
    followChanges: {
      label: "Las traducciones siguen los cambios",
      help: "Cuando cambia el texto original, las traducciones se actualizan también.",
    },
    aiWriting: {
      label: "Escribir y mejorar textos con IA",
      help: "Descripciones de producto, títulos SEO y metadescripciones en su idioma principal.",
    },
    bulkEditor: {
      label: "Editor de hoja de cálculo para todo el catálogo",
      help: "Edite títulos, campos SEO, precios y más de muchos elementos a la vez, en una sola tabla.",
    },
    seoToolkit: {
      label: "Herramientas SEO",
      help: "Palabras clave, puntuación SEO, rastreo del sitio, redirecciones y Google Search Console.",
    },
    aiVisibility: {
      label: "Visibilidad en búsquedas con IA",
      help: "Datos estructurados y archivos que ayudan a ChatGPT, Perplexity y otros a entender su tienda.",
    },
    altText: {
      label: "Textos alternativos escritos por IA",
      help: "La IA escribe una descripción para cada imagen.",
    },
    imageManager: {
      label: "Galerías de imágenes por variante",
      help: "Varias imágenes por variante, subida masiva y conversión a WebP.",
    },
    imagesPerLanguage: {
      label: "Imágenes distintas por idioma",
      help: "Mostrar otra imagen en cada idioma, por ejemplo una con texto.",
    },
    currency: {
      label: "Conversión de moneda por la app",
      help: "Shopify Markets ya convierte los precios; algunas apps añaden su propio conversor.",
    },
    metaAi: {
      label: "Títulos SEO y metadescripciones con IA",
      help: "La IA escribe títulos y descripciones para los resultados de búsqueda.",
    },
    structuredData: {
      label: "Datos estructurados (JSON-LD)",
      help: "Datos de producto, reseñas y preguntas frecuentes en la forma que Google lee para resultados enriquecidos.",
    },
    storeAudit: {
      label: "Auditoría de la tienda con puntuación SEO",
      help: "Revisa todo el contenido y muestra lo que falta o sobra.",
    },
    seoPerLanguage: {
      label: "SEO en todos los idiomas",
      help: "Puntuación, auditoría y correcciones con IA también para el contenido traducido.",
    },
    siteCrawl: {
      label: "Rastreo en vivo de la tienda",
      help: "Descarga las páginas reales de su tienda y revisa lo que se sirve.",
    },
    brokenLinks: {
      label: "Encontrar enlaces rotos",
      help: "Enlaces internos y externos que no llevan a ninguna parte.",
    },
    redirects: {
      label: "Páginas 404 y redirecciones",
      help: "Detecta páginas 404 visitadas y redirige direcciones antiguas.",
    },
    internalLinks: {
      label: "Enlazado interno",
      help: "Sugiere enlaces entre sus páginas.",
    },
    sitemapControl: {
      label: "Control del sitemap",
      help: "Decide qué páginas aparecen en el sitemap.",
    },
    pageSpeed: {
      label: "Medir la velocidad",
      help: "PageSpeed y datos de visitantes reales.",
    },
    speedOptimization: {
      label: "Mejoras automáticas de velocidad",
      help: "Modifica el código del tema, por ejemplo con carga diferida o minificación.",
    },
    imageCompression: {
      label: "Comprimir imágenes",
      help: "Archivos de imagen más pequeños, por ejemplo en WebP.",
    },
    searchConsole: {
      label: "Google Search Console",
      help: "Clics, impresiones y posiciones dentro de la app.",
    },
    keywordTracking: {
      label: "Seguimiento de palabras clave",
      help: "Qué términos corresponden a cada página y cómo evolucionan.",
    },
    keywordVolume: {
      label: "Volumen de búsqueda",
      help: "Estima cuántas veces se busca un término.",
    },
    indexNow: {
      label: "IndexNow",
      help: "Comunica al instante páginas nuevas y modificadas a Bing y otros buscadores.",
    },
    localSeo: {
      label: "SEO local y backlinks",
      help: "Datos para la búsqueda local y análisis de enlaces externos a su tienda.",
    },
    aiDiscoveryFiles: {
      label: "llms.txt y agents.md",
      help: "Archivos que explican su tienda a los asistentes de IA.",
    },
    aiCrawlers: {
      label: "Rastreadores de IA en robots.txt",
      help: "Decide qué servicios de búsqueda con IA pueden leer su tienda.",
    },
    aiReferral: {
      label: "Visitas desde asistentes de IA",
      help: "Cuenta los visitantes que llegan desde ChatGPT, Perplexity y otros.",
    },
    catalogReadiness: {
      label: "Catálogo listo para compras con IA",
      help: "Muestra productos sin marca, categoría, GTIN, descripción o imagen.",
    },
    ownKey: {
      label: "Clave de IA propia",
      help: "Usa su propia cuenta con el proveedor de IA y le paga directamente.",
    },
    includedAi: {
      label: "IA incluida en el plan",
      help: "Sin clave propia: el uso de la IA va incluido en el precio.",
    },
    productDescriptions: {
      label: "Descripciones de producto",
      help: "La IA escribe o mejora los textos de producto.",
    },
    blogArticles: {
      label: "Artículos de blog",
      help: "La IA escribe artículos para su blog.",
    },
    imageToText: {
      label: "Texto a partir de la imagen",
      help: "La IA mira la imagen y describe lo que aparece.",
    },
    aiImages: {
      label: "Generar imágenes",
      help: "La IA crea imágenes nuevas.",
    },
    marketingTexts: {
      label: "Anuncios, correos y redes sociales",
      help: "Textos para boletines, anuncios y publicaciones.",
    },
    bulkGeneration: {
      label: "Muchos textos a la vez",
      help: "La IA escribe textos para muchos productos de una vez.",
    },
    createWithAi: {
      label: "Crear contenido nuevo con IA",
      help: "Al crear un producto o artículo, la IA completa el resto de campos.",
    },
    translateGenerated: {
      label: "Traducir los textos generados",
      help: "Lo que escribe la IA se traduce a sus otros idiomas.",
    },
    multiImagePerVariant: {
      label: "Varias imágenes por variante",
      help: "Cada variante tiene su propia galería.",
    },
    variantFilter: {
      label: "La galería sigue a la variante",
      help: "Al cambiar de variante solo se ven sus imágenes.",
    },
    noLayoutShift: {
      label: "Sin saltos al cargar",
      help: "La galería aparece en su sitio desde el principio.",
    },
    zoomLightbox: {
      label: "Zoom y pantalla completa",
      help: "Ampliar imágenes y verlas en una ventana.",
    },
    videoAnd3d: {
      label: "Vídeos y modelos 3D",
      help: "También vídeos y modelos 3D en la galería de variantes.",
    },
    autoAssign: {
      label: "Asignar imágenes automáticamente",
      help: "Asignar muchas imágenes a sus variantes de una vez.",
    },
    keyGenerator: {
      label: "Claves de imagen para todas las variantes",
      help: "Crea claves de asignación con un clic y recuerda sus nombres.",
    },
    dragDrop: {
      label: "Asignar arrastrando",
      help: "Arrastrar imágenes a mano a la galería de una variante.",
    },
    bulkUpload: {
      label: "Carga masiva",
      help: "Subir muchas imágenes en un solo paso.",
    },
    swatchesProduct: {
      label: "Muestras de color o imagen en la página de producto",
      help: "Pequeños colores o imágenes para elegir la variante.",
    },
    swatchesCollection: {
      label: "Muestras en las páginas de colección",
      help: "Variantes elegibles ya en el listado de productos.",
    },
    combinedListings: {
      label: "Combinar o dividir productos",
      help: "Mostrar varios productos como uno o dividir uno por color.",
    },
    altTranslation: {
      label: "Traducir textos alternativos",
      help: "Las descripciones de imagen aparecen en cada idioma de su tienda.",
    },
  },
  ourStrengths: [
    "Las traducciones se guardan en su tienda Shopify y se conservan si desinstala la aplicación.",
    "Traducción con IA en todos los idiomas de su tienda, con su propio tono, sus reglas y su glosario.",
    "Usted elige el proveedor de IA y le paga directamente, a precio de coste, o elige un plan con IA incluida.",
    "Traduce textos de otras apps y actualiza las traducciones cuando cambia el texto original.",
    "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
    "Herramientas SEO completas, visibilidad en búsquedas con IA y un editor de hoja de cálculo para todo el catálogo.",
    "Galerías de imágenes por variante con carga masiva y conversión a WebP.",
  ],
  ourStrengthsByTopic: {
    seo: [
      "Auditoría SEO, puntuación y correcciones con IA en todos los idiomas de su tienda, no solo en el principal.",
      "Rastreo en vivo en dos pasos: entrega, y on-page e indexación, comparado con la ejecución anterior.",
      "Redirecciones también para direcciones traducidas cuando cambia un handle.",
      "Búsqueda con IA: llms.txt y agents.md, rastreadores de IA en robots.txt, visitas desde asistentes de IA y una revisión del catálogo para compras con IA.",
      "Search Console, palabras clave por idioma, IndexNow y enlazado interno con vista previa antes de cada cambio.",
      "Traducción, textos con IA e imágenes de variantes en el mismo plan.",
    ],
    aiContent: [
      "Seis proveedores de IA a elegir: con su propia clave a precio de coste o con IA incluida.",
      "Instrucciones propias por campo y un glosario, para acertar con el tono y los términos.",
      "Escribe textos de producto, campos SEO, textos alternativos y artículos, mirando la imagen del producto si lo desea.",
      "Crea productos y artículos nuevos y completa el resto de campos con IA.",
      "Traduce lo que escribe a todos los idiomas de su tienda y mantiene las traducciones al día.",
      "Un editor de hoja de cálculo para muchos textos a la vez.",
    ],
    variantImages: [
      "Varias imágenes, vídeos y modelos 3D por variante, con zoom y pantalla completa.",
      "Asignación automática por nombre de archivo y SKU o clave de imagen, con un generador de claves que recuerda sus nombres.",
      "Carga masiva con conversión a WebP.",
      "Textos alternativos con IA, traducidos a todos los idiomas de su tienda.",
      "Parte del mismo plan que la traducción, el SEO y los textos con IA: ninguna app aparte solo para imágenes.",
    ],
  },
  ourNotes: {
    blogArticles: "Un artículo a partir de título y palabra clave; sin planificador de blog",
    autoTranslate: "Con su propia clave de IA o con IA incluida",
    aiProvider: "Seis proveedores",
    imagesPerLanguage: "Aún no",
    currency: "Lo hace Shopify Markets",
    speedOptimization: "Deliberadamente no: nunca tocamos el código del tema",
    keywordVolume: "Search Console da cifras reales",
    includedAi: "Gratis: un saldo de prueba único",
    swatchesProduct: "Todavía no",
  },
  topics: {
    nav: "Temas",
    suite: "Un plan de ContentPilot cubre todos los temas: traducción, SEO, textos con IA e imágenes de variantes.",
    preview: "Vista previa: los datos de las otras apps aún no se han comprobado. Esta página no es pública.",
    items: {
      translation: { tab: "Traducción" },
      seo: {
        tab: "SEO",
        title: "ContentPilot comparado con apps de SEO para Shopify",
        intro:
          "Cómo se compara ContentPilot AI con apps de SEO conocidas para Shopify: auditoría, rastreo, Google, búsqueda con IA, y dónde las otras ofrecen más.",
      },
      aiContent: {
        tab: "Textos con IA",
        title: "ContentPilot comparado con apps de textos con IA para Shopify",
        intro:
          "Cómo se compara ContentPilot AI con apps que escriben textos de producto, campos SEO y artículos con IA.",
      },
      variantImages: {
        tab: "Imágenes de variantes",
        title: "ContentPilot comparado con apps de imágenes por variante",
        intro:
          "Cómo se compara la galería de variantes de ContentPilot AI con apps especializadas en varias imágenes por variante.",
      },
    },
  },
  aboutHeading: "Cómo funciona {name}",
  strengthsHeading: "Dónde destaca {name}",
  ourEdgeHeading: "Lo que añade ContentPilot",
  verdictHeading: "¿Cuál le conviene?",
  checkedAt: "octubre de 2026",
  disclaimer:
    "Basado en las fichas de la App Store y las páginas de ayuda de cada proveedor, a fecha de {date}. Las apps cambian rápido: consulte la ficha actual antes de decidir. «Sin datos» significa que no encontramos una respuesta clara, no que falte la función.",
  correction: "¿Algo está desactualizado? Escríbanos y lo corregimos.",
  detailLink: "Comparación completa",
  otherComparisons: "Otras comparaciones",
  allComparisons: "Todas las comparaciones",
  tableNote:
    "«Plan superior» significa que la app ofrece la función, pero no en el plan mostrado. Una app con menos planes muestra su plan más alto en los niveles superiores.",
  glance: {
    heading: "Comparar plan por plan",
    intro: "Elija un nivel de plan. Cada columna muestra entonces el plan de esa app en ese nivel: precio, límites y qué funciones incluye.",
    planColumn: "Plan",
    levelPicker: "Nivel de plan",
    topPlan: "plan más alto",
    planGroup: "Plan",
    freeLevel: "Gratis",
    level: "Nivel {n}",
    priceLabel: "Precio",
    languagesLabel: "Idiomas",
    productsLabel: "Productos",
    aiLabel: "Traducciones",
    quotaLabel: "Cupo de IA",
    restrictions: {
      devStoresOnly: "Solo para tiendas de desarrollo y de prueba",
      freeThemesOnly: "Solo con temas gratuitos de Shopify",
    },
    enginesLabel: "Proveedores de IA",
    engines: {
      ownKey: "{list}: con su propia clave",
      plusOwnKey: "Clave propia: {list}",
      shopify: "Traducción automática de Shopify",
      vendor: "IA propia del proveedor, no seleccionable",
      unstated: "Traducción automática, motor no indicado",
      unstatedModel: "Modelo de IA no indicado",
      manual: "Ninguno: solo traducción manual",
    },
    trialRow: "Prueba gratuita",
    includedAi: {
      price: "o {price} con IA incluida",
      taster: "O, una sola vez, unas {n} acciones de IA para probar, sin clave propia",
      volume: {
        basic: "Con IA incluida: alcanza para unos 300–500 productos, cada uno traducido a un idioma, al mes",
        pro: "Con IA incluida: alcanza para unos 600–1.000 productos, cada uno traducido a un idioma, al mes",
        max: "Con IA incluida: alcanza para unos 1.500–2.500 productos, cada uno traducido a un idioma, al mes",
      },
      engines: "Con IA incluida: {list}",
    },
    addApp: "Comparar más aplicaciones",
    removeApp: "Quitar {name} de la comparación",
    strengthsGroup: "Puntos fuertes",
    strengthsRow: "Dónde destaca la aplicación",
    strengthsHelp: "Según la información del proveedor, resumida por nosotros.",
    values: {
      unlimited: "Ilimitados",
      shopifyMax: "Todos los que permite Shopify (hasta 20)",
      pending: "En revisión",
      someAutomatic: "2 automáticos, los demás a mano",
      automaticOf: "{auto} con IA, hasta {total} en total",
      manualOnly: "Solo traducción manual",
      wordsOnce: "{n} palabras una sola vez, más en paquetes de palabras",
      credits: "{n} créditos de IA",
      creditsMonth: "{n} créditos de IA / mes",
      creditsOnce: "{n} créditos de IA, una sola vez",
      tokensOnce: "{n} tokens de IA, una sola vez",
      postsMonth: "{n} artículos / mes",
      descriptionsManual: "{n} descripciones, iniciadas a mano",
      aiUpToProducts: "IA para hasta {n} productos",
      unlimitedAi: "IA ilimitada",
      oncePerLanguage: "Una sola vez por idioma, contado en productos y no en palabras",
      oncePerLanguageOrOwnKey: "Una sola vez por idioma; ilimitado con su propia clave de API",
      noProductLimit: "Sin límite",
      ownKey: "Con su propia clave de IA: ilimitado, paga directamente a su proveedor de IA",
      included: "Incluido",
      unlimitedWords: "Palabras ilimitadas",
      words: "{n} palabras",
      tokensMonth: "{n} tokens de IA / mes",
      tokensMonthOwnKey: "{n} tokens de IA / mes o su propia clave de IA",
      wordsPlusTokens: "Palabras ilimitadas (Google) + {n} tokens de IA / mes",
      wordsPlusTokensOwnKey: "Palabras ilimitadas (Google) + {n} tokens de IA / mes o su propia clave de IA",
      unstated: "Sin datos",
      trialDays: "{n} días",
      noTrial: "No hace falta: es gratis",
      notOffered: "Sin plan en este nivel",
      onRequest: "A consultar",
      oneLanguage: "1",
      languages: "{n}",
    },
  },
  pricing: {
    perMonth: "/ mes",
    perYear: "/ año",
    free: "Gratis",
    onRequest: "Precio a consultar",
    byShopifyPlan: "según su plan de Shopify",
    planByShopifyPlan: "Según el plan de Shopify",
    note: "Precios mensuales en la moneda del proveedor, sin impuestos. Varios proveedores son más baratos con pago anual. Con ContentPilot usa su propia clave de IA —y su proveedor de IA le factura el uso por separado— o un plan con IA incluida.",
  },
  competitors: {
    "translate-and-adapt": {
      kind: "La app de traducción gratuita de Shopify",
      summary:
        "Translate & Adapt es gratuita y la hace Shopify. ContentPilot añade traducción con IA en todos los idiomas según sus propias instrucciones, glosario, textos de otras apps, herramientas SEO y redacción de contenido. Así se comparan.",
      about:
        "Translate & Adapt es de Shopify y no cuesta nada. Traduce automáticamente hasta dos idiomas; cada idioma adicional se traduce a mano. Su gran punto fuerte es adaptar el contenido por mercado, por ejemplo distintas formas de escribir para España y México.",
      strengths: [
        "Totalmente gratuita, hecha por la propia Shopify.",
        "Adapta textos por mercado, como el español de España y el de México.",
        "Cubre tema, checkout y correos de notificación.",
        "Encaja bien si necesita uno o dos idiomas más y le basta una traducción automática estándar.",
      ],
      ourEdge: [
        "Traducción con IA en todos los idiomas de su tienda, con su propio tono y sus reglas.",
        "Un glosario, para que los nombres de marca y términos fijos nunca se traduzcan mal.",
        "Traduce textos de otras apps, como los widgets de reseñas.",
        "Actualiza las traducciones automáticamente cuando cambia el texto original.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas y un editor de hoja de cálculo para todo el catálogo.",
      ],
      verdict:
        "Quédese con Translate & Adapt si vende en uno o dos idiomas adicionales y le basta una traducción automática estándar. Elija ContentPilot si quiere traducciones con su propio tono y glosario, traducir los textos de otras apps o una sola app para textos, SEO y traducciones. Ambas guardan en el almacén de traducciones de Shopify, así que puede cambiar cuando quiera y conservar todo.",
      notes: {
        autoTranslate: "Dos idiomas",
        followChanges: "Sincronización semanal, desactivada por defecto",
        imagesPerLanguage: "Solo imágenes del tema",
      },
    },
    weglot: {
      kind: "Servicio de traducción para muchas plataformas web",
      summary:
        "Weglot traduce sitios web en muchas plataformas y cobra por palabras traducidas. ContentPilot funciona dentro de Shopify, guarda las traducciones en su tienda y añade herramientas SEO y de contenido. Así se comparan.",
      about:
        "Weglot es un servicio de traducción para muchas plataformas web, entre ellas Shopify. Detecta los textos de su tienda y sirve las páginas traducidas desde su propio sistema. Las traducciones se guardan en los servidores de Weglot, no en Shopify. Los planes dependen del número de idiomas y de palabras traducidas.",
      strengths: [
        "Producto maduro con un editor visual que muestra las traducciones en la página.",
        "Glosario y una IA que aprende la voz de su marca.",
        "Traduce textos de otras apps y cambia imágenes por idioma.",
        "Traducción profesional humana opcional.",
      ],
      ourEdge: [
        "Las traducciones se guardan en su tienda Shopify y se conservan si desinstala la app.",
        "Todos los idiomas que permite Shopify en todos los planes y sin límite de palabras; los planes se miden por número de productos.",
        "Usted elige el proveedor de IA y le paga directamente, a precio de coste.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas, visibilidad en búsquedas con IA y un editor de hoja de cálculo para todo el catálogo.",
      ],
      verdict:
        "Elija Weglot si tiene sitios en varias plataformas y quiere un único servicio de traducción para todos, o si necesita traductores profesionales. Elija ContentPilot si su tienda funciona con Shopify, quiere que las traducciones pertenezcan a su tienda y no quiere límites de palabras.",
      notes: {
        brandVoice: "Solo formal o informal",
        nativeStorage: "Guardadas en Weglot",
      },
    },
    transcy: {
      kind: "App de traducción y moneda para Shopify",
      summary:
        "Transcy combina traducción, conversión de moneda y traducción de imágenes. ContentPilot combina la traducción con IA con herramientas SEO y de contenido. Así se comparan.",
      about:
        "Transcy es una app de Shopify que combina la traducción con un conversor de moneda, la detección de la ubicación del visitante y la traducción de imágenes. Trabaja con varios motores de traducción e incluye un selector de idioma y moneda para la tienda.",
      strengths: [
        "Traducción, conversión de moneda y detección de ubicación en una sola app.",
        "Traduce el texto que aparece dentro de las imágenes.",
        "Glosario y elección entre varios motores de traducción.",
        "Traduce textos de otras apps.",
      ],
      ourEdge: [
        "Instrucciones propias para la IA, para que las traducciones sigan su tono.",
        "Todos los idiomas que permite Shopify, en todos los planes.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas y visibilidad en búsquedas con IA.",
        "Un editor de hoja de cálculo para todo el catálogo y galerías de imágenes por variante.",
      ],
      verdict:
        "Elija Transcy si necesita un conversor de moneda más allá de Shopify Markets o traducir el texto dentro de las imágenes. Elija ContentPilot si quiere traducciones con su propio tono y una sola app para textos, SEO y traducciones.",
      notes: {
        aiProvider: "Varios motores de IA",
      },
    },
    langshop: {
      kind: "App de traducción para Shopify",
      summary:
        "LangShop traduce tiendas Shopify con varios motores de IA y ofrece conversión de moneda. ContentPilot añade herramientas SEO, redacción de contenido y todos los idiomas que permite Shopify en todos los planes. Así se comparan.",
      about:
        "LangShop es una app de traducción para Shopify que trabaja con varios motores de IA o con traductores humanos. Cubre la tienda, el checkout y los textos de otras apps, e incluye un conversor de moneda y un selector de idioma.",
      strengths: [
        "Muchísimos idiomas, incluidos los que se escriben de derecha a izquierda.",
        "Varios motores de IA y traducción humana opcional.",
        "Glosario y reglas de traducción propias.",
        "Conversión de moneda y selector de idioma.",
      ],
      ourEdge: [
        "Todos los idiomas que permite Shopify, en todos los planes.",
        "Usted elige el proveedor de IA y le paga directamente, a precio de coste.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas y visibilidad en búsquedas con IA.",
        "Un editor de hoja de cálculo para todo el catálogo y galerías de imágenes por variante.",
      ],
      verdict:
        "Elija LangShop si quiere traductores humanos a su disposición o un conversor de moneda más allá de Shopify Markets. Elija ContentPilot si quiere todos los idiomas de su tienda y una sola app para textos, SEO y traducciones.",
      notes: {
        aiProvider: "Varios motores de IA",
        bulkEditor: "Solo traducciones",
        followChanges: "Productos y colecciones nuevos",
      },
    },
    "t-lab": {
      kind: "Aplicación de traducción con IA para Shopify",
      summary:
        "T Lab traduce tiendas Shopify con IA, por niveles de idiomas y número de productos. ContentPilot añade traducción con IA en todos los idiomas de su tienda, sus propias instrucciones para la IA, herramientas SEO y redacción de contenidos. Así se comparan.",
      about:
        "T Lab es una aplicación de traducción para Shopify que escribe en el almacenamiento de traducciones de Shopify. Traduce a mano o con una IA basada en OpenAI; cuántos idiomas traduce la IA, y para cuántos productos, depende del plan. Esos cupos son únicos por idioma y no se renuevan cada mes. Lo que Shopify no puede traducir —imágenes, textos de otras apps, textos fijos— la app lo sustituye con un script en la tienda.",
      strengths: [
        "Un plan gratuito con traducción con IA a un idioma y hasta 500 productos.",
        "Glosario y traducción de imágenes incluso en el plan gratuito.",
        "Traduce textos de otras apps como Judge.me o PageFly.",
        "Autopilot en Premium traduce automáticamente el contenido nuevo y modificado; clave propia de OpenAI, Anthropic, DeepL, DeepSeek o Google.",
      ],
      ourEdge: [
        "Traducción con IA en todos los idiomas de su tienda, sin un cupo único por idioma.",
        "Sus propias instrucciones y un glosario, para que la IA traduzca con su tono.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas y visibilidad en búsquedas con IA.",
        "Un editor de hoja de cálculo para todo el catálogo y galerías de imágenes por variante.",
      ],
      verdict:
        "Elija T Lab si quiere traducir pocos idiomas con IA a bajo precio y necesita traducir imágenes, textos de otras apps o monedas. Elija ContentPilot si quiere todos los idiomas de su tienda con su propio tono, sin un cupo único por idioma, y una sola app para textos, SEO y traducciones.",
      notes: {
        nativeStorage: "Imágenes y sustituciones propias mediante la app",
        brandVoice: "Contexto de la tienda; tono solo con clave propia",
        themeCheckout: "Correos: sin datos",
        followChanges: "Automático con Autopilot (Premium)",
        currency: "No en el checkout",
        aiProvider: "Mediante su propia clave de API",
      },
    },
    langify: {
      kind: "Aplicación de traducción para Shopify",
      summary:
        "Langify traduce tiendas Shopify a mano o de forma automática, con un cupo de palabras por plan. ContentPilot añade traducción con IA con sus propias instrucciones, todos los idiomas de su tienda, herramientas SEO y redacción de contenidos. Así se comparan.",
      about:
        "Langify es una aplicación de traducción veterana para Shopify que escribe en el almacenamiento de traducciones de Shopify. En el plan gratuito traduce a mano hasta cinco idiomas. Los planes de pago traducen automáticamente con DeepL y Google; su cupo de palabras se abona una sola vez al contratar y se pueden comprar más en paquetes. La traducción con IA está en una beta cerrada desde Growth.",
      strengths: [
        "Traducciones manuales ilimitadas en todos los planes, también en el gratuito.",
        "Traducción del checkout y de las notificaciones incluso en el plan gratuito.",
        "Traducción de imágenes e importación y exportación de traducciones desde el plan Basic.",
        "Control total: la app nunca traduce por sí sola, solo cuando usted lo indica.",
      ],
      ourEdge: [
        "Traducción con IA sin cupo de palabras: paga directamente a su proveedor de IA o elige un plan con IA incluida.",
        "Las traducciones siguen automáticamente los cambios del texto original.",
        "Sus propias instrucciones y un glosario para la IA.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO, visibilidad en búsquedas con IA y un editor de hoja de cálculo para todo el catálogo.",
      ],
      verdict:
        "Elija Langify si traduce sobre todo a mano y quiere lanzar cada traducción usted mismo. Elija ContentPilot si quiere que la IA haga la mayor parte de la traducción, sin cupo de palabras, con su propio tono y también cuando cambia el texto original.",
      notes: {
        nativeStorage: "Sustituciones propias mediante la app",
        brandVoice: "Solo tú/usted con DeepL",
        aiProvider: "DeepL o la beta de IA",
        followChanges: "A mano con «Translate outdated»",
        seoToolkit: "Traduce título y descripción SEO",
        imagesPerLanguage: "Imágenes de producto, colección, artículo y tema",
      },
    },
    gtranslate: {
      kind: "Servicio de traducción para muchas plataformas web",
      summary:
        "GTranslate traduce sitios web en muchas plataformas mediante su propia red, sin límite de palabras. ContentPilot funciona dentro de Shopify, guarda las traducciones en su tienda y añade herramientas SEO y de contenido. Así se comparan.",
      about:
        "GTranslate traduce sitios web en muchas plataformas, entre ellas Shopify. El plan gratuito es un selector de idioma que traduce la página en el navegador del visitante, sin indexación en buscadores y sin edición. Los planes de pago sirven las páginas traducidas desde su propia «Translation Delivery Network», así que las traducciones se guardan en GTranslate.",
      strengths: [
        "Todos los idiomas y palabras ilimitadas, incluso en planes económicos.",
        "Su proxy también traduce la mayoría de los textos de otras apps (planes de pago).",
        "Las páginas traducidas se indexan, URL traducidas desde Business y dominios por país.",
        "Funciona en muchas plataformas, no solo en Shopify; 15 días de prueba.",
      ],
      ourEdge: [
        "Las traducciones se guardan en su tienda Shopify y se conservan si desinstala la aplicación.",
        "Traducción con IA con su propio tono, con glosario y elección del proveedor de IA.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO, visibilidad en búsquedas con IA y un editor de hoja de cálculo para todo el catálogo.",
      ],
      verdict:
        "Elija GTranslate si traduce sitios web en varias plataformas con un solo servicio y no quiere límite de palabras. Elija ContentPilot si su tienda funciona con Shopify, quiere que las traducciones pertenezcan a su tienda y busca textos, SEO y traducciones en una sola app.",
      notes: {
        nativeStorage: "Se guardan en GTranslate",
        glossary: "Solo excluir términos",
        themeCheckout: "Checkout y correos: sin datos",
        followChanges: "Cuando caduca la caché",
        seoToolkit: "Indexación y URL traducidas",
        aiVisibility: "Páginas traducidas legibles para rastreadores de IA",
      },
    },
    "avada-seo": {
      kind: "App de SEO y velocidad para Shopify",
      summary:
        "Avada AI SEO combina optimización de imágenes, modos de velocidad, auditorías y SEO técnico. ContentPilot añade SEO en todos los idiomas, un rastreo en vivo, búsqueda con IA y traducción. Así se comparan.",
      about:
        "Avada AI SEO es una app amplia de SEO técnico centrada en imágenes y velocidad: compresión de imágenes y textos alternativos con IA, modos de velocidad que modifican una copia de su tema, una lista de comprobación de la tienda y auditorías de página con puntuación, datos estructurados, un gestor de 404 con redirecciones automáticas, sitemaps e informes de Search Console. Los artículos, las descripciones de producto y llms.txt están en apps de Avada aparte.",
      strengths: [
        "Compresión de imágenes y textos alternativos con IA, ya en el plan gratuito.",
        "Modos de velocidad con carga diferida y scripts aplazados.",
        "Datos estructurados, gestor de 404, sitemaps y una vista de tabla para los campos meta.",
        "Sugerencias de enlaces internos con textos de anclaje por IA desde Pro.",
      ],
      ourEdge: [
        "Auditoría SEO, puntuación y correcciones con IA en todos los idiomas de su tienda, y traducción en la misma app.",
        "Un rastreo en vivo que encuentra los enlaces rotos y dónde están, no solo direcciones 404.",
        "Búsqueda con IA en la misma app: llms.txt y agents.md, rastreadores de IA, visitas desde asistentes de IA.",
        "Sin cambios en el código de su tema: la velocidad queda como diagnóstico.",
      ],
      verdict:
        "Elija Avada si la velocidad y la optimización de imágenes son su prioridad y acepta que una app modifique una copia de su tema. Elija ContentPilot si vende en varios idiomas y quiere SEO, búsqueda con IA y traducción en una sola app.",
      notes: {
        brokenLinks: "Direcciones 404, sin la página de origen",
        keywordTracking: "Solo posiciones de Search Console",
        indexNow: "API de indexación de Google y Bing",
        localSeo: "SEO local sí, backlinks sin datos",
        aiDiscoveryFiles: "llms.txt en otra app de Avada",
        aiCrawlers: "Editor de robots.txt, sin nombrar bots de IA",
        seoPerLanguage: "Sin traducción automática",
        siteCrawl: "Comprobación en vivo dentro de la auditoría",
      },
    },
    storeseo: {
      kind: "App de SEO con IA para Shopify",
      summary:
        "StoreSEO cubre SEO on-page, schema, sitemaps y visibilidad en IA, por niveles según el número de productos. ContentPilot añade SEO en todos los idiomas desde el primer plan, un rastreo en vivo y traducción. Así se comparan.",
      about:
        "StoreSEO es una app de SEO todo en uno muy centrada en la IA: un agente de SEO con IA, conexión con Claude y ChatGPT, análisis on-page, schema, sitemaps, optimización de imágenes y herramientas de palabras clave. Los planes se escalonan por productos (de 25 a 10.000), imágenes y créditos de IA; el SEO multilingüe empieza en Growth.",
      strengths: [
        "llms.txt y agents.md en el plan gratuito.",
        "Mide visitas, pedidos e ingresos desde asistentes de IA y menciones de la marca en respuestas de IA.",
        "Investigación de palabras clave con volumen de búsqueda y seguimiento de posiciones.",
        "SEO masivo eligiendo el modelo de IA, también Claude.",
      ],
      ourEdge: [
        "SEO en todos los idiomas en cada plan, y traducción en la misma app.",
        "Un rastreo en vivo con enlaces rotos, redirecciones y revisión on-page.",
        "Un límite más alto en el plan gratuito: 50 productos en vez de 25.",
        "Una revisión del catálogo para compras con IA que también comprueba el GTIN.",
      ],
      verdict:
        "Elija StoreSEO si lo más importante es medir la visibilidad en IA y las menciones de su marca y su catálogo es pequeño. Elija ContentPilot si vende en varios idiomas y quiere SEO, traducción y textos con IA en un solo plan.",
      notes: {
        brokenLinks: "Solo mencionado, sin descripción",
        redirects: "301 masivos, sin detección de 404",
        indexNow: "Protocolo no indicado",
        localSeo: "SEO local sí, backlinks sin datos",
        catalogReadiness: "Puntuación sin GTIN",
        structuredData: "En el plan gratuito solo JSON-LD propio",
      },
    },
    seowill: {
      kind: "App de SEO y velocidad para Shopify",
      summary:
        "SEOWILL reúne auditorías, textos meta y alternativos por reglas, optimización de velocidad, schema y un redactor de blog con IA. ContentPilot añade textos SEO escritos por IA, SEO en todos los idiomas y traducción. Así se comparan.",
      about:
        "SEOWILL (antes SEOAnt) es un paquete completo: auditoría, optimización masiva de textos meta y alternativos por reglas, schema, optimización de velocidad sobre una copia de su tema, redirecciones 404, investigación de palabras clave, artículos de blog con IA e intercambio de backlinks. La IA está sobre todo en la auditoría de contenido y en el redactor de blog; los textos meta y alternativos usan plantillas.",
      strengths: [
        "Muchas herramientas en una app a bajo precio.",
        "Schema amplio, también FAQ, HowTo y LocalBusiness.",
        "Investigación de palabras clave con volumen y dificultad.",
        "Modos de velocidad y AMP, además de intercambio y auditoría de backlinks.",
      ],
      ourEdge: [
        "Títulos SEO, metadescripciones y textos alternativos escritos por IA, no por plantillas.",
        "SEO en todos los idiomas de su tienda, y traducción.",
        "Un rastreo en vivo que encuentra los enlaces rotos y dónde están.",
        "Sin cambios en el código de su tema.",
      ],
      verdict:
        "Elija SEOWILL si quiere muchas herramientas de SEO y velocidad a bajo precio y le bastan plantillas para los textos meta. Elija ContentPilot si quiere textos escritos por IA en todos los idiomas y una sola app para SEO, traducción y contenido.",
      notes: {
        metaAi: "Reglas y plantillas",
        bulkEditor: "Textos alternativos gratis, meta desde Pro",
        altText: "Plantillas, no IA",
        seoPerLanguage: "Solo edición, sin traducción",
        brokenLinks: "Solo 404 visitados",
        sitemapControl: "Solo sitemap HTML",
        indexNow: "Solo Google",
        aiDiscoveryFiles: "Solo llms.txt",
        siteCrawl: "Alcance del escaneo no indicado",
      },
    },
    tinyseo: {
      kind: "App de SEO y optimización de imágenes para Shopify",
      summary:
        "TinySEO (antes TinyIMG) es un paquete económico de velocidad y SEO que se cobra por imágenes. ContentPilot añade textos con IA en todos los idiomas, SEO por idioma y traducción. Así se comparan.",
      about:
        "TinySEO viene de la optimización de imágenes y hoy es un paquete económico de velocidad y SEO: compresión automática de imágenes, plantillas para textos alternativos y nombres de archivo, carga diferida y minificación en el tema, auditoría del sitio, JSON-LD, redirecciones 404, llms.txt y agents.md e informes de Search Console. Se cobra por imágenes; los créditos de IA son escasos (de 10 a 1.000 al mes).",
      strengths: [
        "Compresión, redimensionado y nombres de archivo amigables para SEO.",
        "Carga diferida y minificación de CSS y JS.",
        "IndexNow, llms.txt y agents.md desde Advanced.",
        "Redirecciones 404 con reglas y comodines.",
      ],
      ourEdge: [
        "Textos SEO y alternativos escritos por IA sin un cupo de créditos escaso.",
        "SEO en todos los idiomas de su tienda, y traducción.",
        "Un rastreo en vivo y sugerencias de enlaces internos.",
        "Sin cambios en el código de su tema.",
      ],
      verdict:
        "Elija TinySEO si la optimización de imágenes y de velocidad con poco presupuesto es su prioridad. Elija ContentPilot si quiere textos con IA en todos los idiomas y una sola app para SEO, traducción y contenido.",
      notes: {
        bulkEditor: "Meta masivo desde Advanced",
        structuredData: "En el plan gratuito solo datos generales",
        siteCrawl: "Auditoría del sitio, método no indicado",
        brokenLinks: "Datos contradictorios",
        internalLinks: "Solo páginas huérfanas",
        keywordVolume: "Solo sugerencias con IA",
      },
    },
    booster: {
      kind: "App de SEO en piloto automático para Shopify",
      summary:
        "Booster es la app de SEO con más reseñas y funciona en piloto automático: etiquetas meta, textos alternativos, schema y redirecciones 404. ContentPilot añade herramientas de palabras clave, SEO por idioma y traducción. Así se comparan.",
      about:
        "Booster se basa en un piloto automático: una vez activado, escribe etiquetas meta (plantillas o IA), textos alternativos, JSON-LD y redirecciones 404 de forma automática y muestra una puntuación de salud. Las herramientas más profundas —palabras clave, velocidad, control del sitemap, varios idiomas— faltan o están en apps hermanas.",
      strengths: [
        "Piloto automático para etiquetas meta, textos alternativos y redirecciones.",
        "Textos alternativos y meta con IA en el plan gratuito para hasta 250 productos.",
        "Puntuación SEO e insignia de salud.",
        "La app de SEO con más reseñas de la Shopify App Store.",
      ],
      ourEdge: [
        "Seguimiento de palabras clave con Search Console, enlaces internos y un rastreo en vivo.",
        "SEO en todos los idiomas de su tienda, y traducción.",
        "Búsqueda con IA: llms.txt y agents.md, rastreadores de IA, visitas desde asistentes de IA.",
        "Ningún piloto automático que sobrescriba su trabajo: usted decide qué cambios de la IA aplicar.",
      ],
      verdict:
        "Elija Booster si quiere que el SEO funcione solo y no necesita herramientas de palabras clave ni de varios idiomas. Elija ContentPilot si quiere controlar los textos, SEO en todos los idiomas y una sola app para SEO, traducción y contenido.",
      notes: {
        bulkEditor: "Plantillas, 200 productos por página",
        brokenLinks: "Solo 404 visitados",
        sitemapControl: "Solo envío a Google",
        pageSpeed: "Fuente de datos no indicada",
        speedOptimization: "App aparte de Booster",
        keywordTracking: "Solo se muestran, sin seguimiento",
        localSeo: "Perfil de Empresa de Google",
        aiDiscoveryFiles: "Solo llms.txt",
      },
    },
    "avada-blog": {
      kind: "App de blog con IA para Shopify",
      summary:
        "Avada Blog escribe y diseña artículos de blog con IA. ContentPilot escribe textos de producto, campos SEO y textos alternativos con el proveedor de IA que usted elija, en todos los idiomas. Así se comparan.",
      about:
        "Avada Blog es un constructor de blogs dentro del admin de Shopify con un redactor de IA: un prompt o un proceso guiado en tres pasos (ajustes, esquema, artículo) crea una entrada que usted diseña en su propio editor y sincroniza con sus blogs de Shopify. Incluye una lista SEO, investigación de palabras clave y un generador de imágenes. Las descripciones de producto están en otra app de Avada.",
      strengths: [
        "Sugerencias de temas, borradores completos y consejos SEO en tiempo real para el blog.",
        "Artículos en varios idiomas.",
        "Investigación de palabras clave para temas de blog.",
        "Imágenes con IA para las entradas y un editor visual.",
      ],
      ourEdge: [
        "Textos de producto, campos SEO y textos alternativos, no solo artículos de blog.",
        "Seis proveedores de IA a elegir, con su propia clave o con IA incluida.",
        "Traducción a todos los idiomas de su tienda, siempre al día.",
        "Herramientas SEO e imágenes de variantes en el mismo plan.",
      ],
      verdict:
        "Elija Avada Blog si el blog es su principal canal de contenido. Elija ContentPilot si quiere que la IA escriba sus textos de producto, campos SEO y traducciones, con el proveedor que elija.",
      notes: {
        aiProvider: "GPT y Claude según el registro de cambios, estado actual poco claro",
        metaAi: "Solo para artículos de blog",
        productDescriptions: "App aparte de Avada",
        bulkGeneration: "Solo resúmenes",
      },
    },
    profitonium: {
      kind: "App de descripciones de producto con IA",
      summary:
        "Profitonium escribe descripciones de producto, campos SEO y textos alternativos de forma masiva con GPT, Claude o Gemini. ContentPilot añade su propia clave, traducción a todos los idiomas y herramientas SEO. Así se comparan.",
      about:
        "Profitonium es una herramienta de catálogo para textos de producto: elija productos o colecciones, los campos (descripción, título, título SEO y meta, etiquetas, texto alternativo) y el idioma, añada sus instrucciones, revise la estimación de créditos, genere, revise y guarde. Puede elegir GPT, Claude y Gemini, con la imagen del producto y la búsqueda web como contexto si lo desea.",
      strengths: [
        "Descripciones, títulos y metadatos SEO de forma masiva.",
        "Elección entre GPT, Claude y Gemini.",
        "Textos generados automáticamente al añadir productos nuevos.",
        "Usa las imágenes de producto como entrada.",
      ],
      ourEdge: [
        "Su propia clave de IA a precio de coste —sin créditos— o IA incluida en el plan.",
        "Traduce a todos los idiomas de su tienda y mantiene las traducciones al día.",
        "Herramientas SEO, un editor de hoja de cálculo e imágenes de variantes en el mismo plan.",
        "Crea productos nuevos con IA, no solo textos para los existentes.",
      ],
      verdict:
        "Elija Profitonium si sobre todo quiere generar textos de producto en masa con un modelo de créditos. Elija ContentPilot si quiere su propia clave, traducciones siempre al día y una sola app para contenido, SEO y traducción.",
      notes: {
        translateGenerated: "Genera en más de 30 idiomas; dónde se guarda no se indica",
      },
    },
    tapita: {
      kind: "App de blog y GEO con IA para Shopify",
      summary:
        "Tapita escribe y programa artículos SEO y mide la visibilidad en IA. ContentPilot escribe textos de producto, campos SEO y textos alternativos en todos los idiomas. Así se comparan.",
      about:
        "Tapita es un estudio de blog y contenido en el admin de Shopify: un formulario con idioma, estilo, tono, descripción del negocio, público, palabras clave, título y esquema genera un artículo con IA que usted edita en un editor de arrastrar y soltar, ilustra con una imagen de IA y publica o programa. Una estrategia de contenido propone planes de temas y escribe entradas en masa.",
      strengths: [
        "Artículos con más de 18 estilos de escritura y 40 tonos.",
        "Un calendario de contenido que publica entradas automáticamente.",
        "Puntuación GEO y medición de la visibilidad en IA.",
        "Imágenes destacadas con IA.",
      ],
      ourEdge: [
        "Textos de producto, campos SEO y textos alternativos, no solo artículos de blog.",
        "Seis proveedores de IA a elegir, con su propia clave o con IA incluida.",
        "Traducción a todos los idiomas de su tienda, siempre al día.",
        "Herramientas SEO e imágenes de variantes en el mismo plan.",
      ],
      verdict:
        "Elija Tapita si quiere un blog que se escriba y publique solo según un calendario. Elija ContentPilot si sus páginas de producto y sus traducciones son el contenido que importa.",
      notes: {
        metaAi: "Solo para artículos de blog",
      },
    },
    "essential-blog": {
      kind: "Redactor de blog con IA para Shopify",
      summary:
        "Essential AI Blog escribe artículos SEO en 13 idiomas y se cobra por artículos al mes. ContentPilot escribe textos de producto, campos SEO y textos alternativos con su propio proveedor de IA. Así se comparan.",
      about:
        "Essential AI Blog es un redactor de blog con IA sencillo: introduzca tema, palabras clave, tono, longitud y esquema, y la app genera un artículo, con una imagen de portada por IA si lo desea. La entrada se guarda en su blog de Shopify (oculta por defecto) y funciona con cualquier constructor de blogs. No tiene editor propio ni acceso a los productos.",
      strengths: [
        "Artículos en 13 idiomas.",
        "Artículos en masa.",
        "Imágenes de portada con IA.",
        "Funciona con cualquier constructor de blogs.",
      ],
      ourEdge: [
        "Textos de producto, campos SEO y textos alternativos: la app no accede a los productos.",
        "Seis proveedores de IA a elegir, con su propia clave o con IA incluida.",
        "Traducción a todos los idiomas de su tienda, siempre al día.",
        "Herramientas SEO e imágenes de variantes en el mismo plan.",
      ],
      verdict:
        "Elija Essential AI Blog si quiere publicar artículos con regularidad de forma sencilla y económica. Elija ContentPilot si quiere IA para el contenido de sus productos y sus traducciones.",
      notes: {
        brandVoice: "Solo el tono",
        translateGenerated: "Escribe directamente en 13 idiomas",
      },
    },
    storeya: {
      kind: "App de descripciones de producto con IA",
      summary:
        "StoreYa escribe descripciones de producto, textos meta y algunos artículos de blog con ChatGPT. ContentPilot añade instrucciones propias, la elección del proveedor de IA y traducción a todos los idiomas. Así se comparan.",
      about:
        "La app de IA de StoreYa es un generador sencillo de textos de producto de una empresa de publicidad: elija un tono, genere descripciones una a una o en masa, títulos y metadescripciones desde Starter, y cada mes algunos artículos con imágenes y textos de boletín. La documentación es escasa.",
      strengths: [
        "Descripciones de producto en masa.",
        "Títulos y metadescripciones.",
        "Artículos con imágenes y textos de boletín.",
        "llms.txt en todos los planes.",
      ],
      ourEdge: [
        "Instrucciones propias por campo y un glosario, no solo un tono.",
        "Seis proveedores de IA a elegir, con su propia clave o con IA incluida.",
        "Traducción a todos los idiomas de su tienda, siempre al día.",
        "Herramientas SEO e imágenes de variantes en el mismo plan.",
      ],
      verdict:
        "Elija StoreYa si quiere generar descripciones de producto rápido y barato. Elija ContentPilot si quiere textos con su propio tono, en todos los idiomas y con el proveedor de IA que elija.",
      notes: {
        brandVoice: "Solo el tono",
        aiImages: "No está claro si las genera la IA",
        marketingTexts: "Solo boletines",
        translateGenerated: "Genera en cualquier idioma; no escribe traducciones",
      },
    },
    rubik: {
      kind: "App de imágenes por variante y muestras para Shopify",
      summary:
        "Rubik asigna imágenes a las variantes con IA y añade muestras, según el número de productos. ContentPilot añade carga masiva, WebP, textos alternativos con IA en todos los idiomas y el resto de la suite. Así se comparan.",
      about:
        "Rubik asigna imágenes, vídeos y modelos 3D a valores de opción (guardados en un metacampo) y filtra la galería existente de su tema; además añade muestras de imagen y color en páginas de producto y tarjetas. La asignación se hace a mano, con una IA que lee títulos, opciones, nombres de archivo, textos alternativos y la propia imagen, o mediante un asistente de IA.",
      strengths: [
        "Asignación de imágenes a variantes con IA, también desde asistentes de IA.",
        "Muestras de imagen y color en páginas de producto y de colección.",
        "Funciona con todos los temas y constructores de páginas.",
        "Imágenes compartidas sin duplicados.",
      ],
      ourEdge: [
        "Carga masiva con conversión a WebP en la misma app.",
        "Textos alternativos con IA, traducidos a todos los idiomas de su tienda.",
        "Un generador de claves que mantiene la asignación coherente en todo el catálogo.",
        "Traducción, SEO y textos con IA en el mismo plan.",
      ],
      verdict:
        "Elija Rubik si necesita muestras y una asignación de imágenes con IA. Elija ContentPilot si quiere galerías por variante junto con optimización de imágenes, textos alternativos y traducción.",
      notes: {
        noLayoutShift: "Solo anuncia «sin impacto en la velocidad»",
        zoomLightbox: "Del tema",
        bulkUpload: "App aparte",
        combinedListings: "App aparte",
      },
    },
    "sa-variant-images": {
      kind: "App de imágenes por variante para Shopify",
      summary:
        "SA Variant Image Automator filtra la galería de su tema por variante y su precio depende de su plan de Shopify. ContentPilot añade carga masiva, WebP, textos alternativos con IA y el resto de la suite. Así se comparan.",
      about:
        "SA filtra la galería existente de su tema sin cambiar su aspecto: las imágenes se arrastran a grupos por variante en el panel, la app reordena los medios de Shopify en consecuencia y reconoce los grupos por su orden. Es deliberadamente limitada: sin muestras, sin carga de imágenes y sin edición. El precio sigue su plan de Shopify; todos los planes incluyen todas las funciones.",
      strengths: [
        "Mantiene el zoom, el vídeo y el 3D de su tema.",
        "Funciona con cualquier tema, constructor de páginas o diseño propio.",
        "Arrastrar y soltar en grupos por variante.",
        "Todas las funciones en todos los planes.",
      ],
      ourEdge: [
        "Carga masiva con conversión a WebP en la misma app.",
        "Textos alternativos con IA, traducidos a todos los idiomas de su tienda.",
        "Asignación automática por nombre de archivo y SKU, con generador de claves.",
        "Traducción, SEO y textos con IA en el mismo plan.",
      ],
      verdict:
        "Elija SA si solo quiere filtrar la galería de su tema por variante sin cambiar nada más. Elija ContentPilot si quiere galerías por variante junto con optimización de imágenes, textos alternativos y traducción.",
      notes: {
        noLayoutShift: "Solo anuncia fidelidad al tema",
        zoomLightbox: "Del tema",
        autoAssign: "Por el orden de las imágenes",
        bulkUpload: "Datos contradictorios",
        swatchesProduct: "App aparte",
        combinedListings: "App aparte",
        altText: "App aparte",
      },
    },
    "op-color-swatch": {
      kind: "App de muestras e imágenes por variante para Shopify",
      summary:
        "OP Color Swatch convierte los desplegables de variantes en muestras y muestra solo las imágenes de la variante elegida. ContentPilot añade textos alternativos con IA, carga masiva, WebP y el resto de la suite. Así se comparan.",
      about:
        "OP Color Swatch es ante todo una app de muestras: sustituye el desplegable de variantes de su tema por muestras de color, imagen, tarjeta, píldora, botón o desplegable en páginas de producto y de colección. Las imágenes por variante se agrupan según su orden en Shopify. Los grupos de productos reúnen productos relacionados en una página. El precio sigue su plan de Shopify; todos los planes incluyen todas las funciones.",
      strengths: [
        "Muestras de color e imagen en páginas de producto y de colección.",
        "Solo las imágenes de la variante elegida, también en las tarjetas de colección.",
        "Grupos que reúnen productos en una página, cada uno con su URL.",
        "Configuración y ajustes del tema gratuitos por el equipo del proveedor.",
      ],
      ourEdge: [
        "Carga masiva con conversión a WebP en la misma app.",
        "Textos alternativos con IA, traducidos a todos los idiomas de su tienda.",
        "Vídeo y 3D en la galería de variantes, con zoom y pantalla completa.",
        "Traducción, SEO y textos con IA en el mismo plan.",
      ],
      verdict:
        "Elija OP Color Swatch si su objetivo principal son las muestras en páginas de producto y de colección. Elija ContentPilot si quiere galerías por variante junto con optimización de imágenes, textos alternativos y traducción.",
      notes: {
        noLayoutShift: "La ayuda menciona un breve parpadeo",
        autoAssign: "Por el orden de las imágenes",
        dragDrop: "Orden en el admin de Shopify",
        combinedListings: "Combinar sí, dividir en otra app",
      },
    },
    "variant-image-wizard": {
      kind: "App de imágenes por variante y muestras para Shopify",
      summary:
        "Variant Image Wizard combina un configurador de muestras con una galería por variante a un precio muy bajo. ContentPilot añade textos alternativos con IA, carga masiva, WebP y el resto de la suite. Así se comparan.",
      about:
        "Variant Image Wizard combina un configurador de muestras (imagen, color, botón o desplegable, con títulos, descripciones emergentes y avisos) con su propia galería por variante con zoom y lightbox. Las imágenes se asignan por variante arrastrando y soltando, y se pueden importar las imágenes de variante de Shopify. Free y Starter solo funcionan con los temas gratuitos de Shopify.",
      strengths: [
        "Precio muy bajo.",
        "Muestras, botones y desplegables con descripciones emergentes.",
        "Galería propia con zoom y lightbox.",
        "Vincula productos como muestras (Pro).",
      ],
      ourEdge: [
        "Funciona con cualquier tema, en todos los planes que incluyen la galería.",
        "Textos alternativos con IA, traducidos a todos los idiomas de su tienda.",
        "Asignación automática por nombre de archivo y SKU, con generador de claves.",
        "Traducción, SEO y textos con IA en el mismo plan.",
      ],
      verdict:
        "Elija Variant Image Wizard si quiere muestras e imágenes por variante al precio más bajo y usa un tema gratuito de Shopify. Elija ContentPilot si quiere galerías por variante junto con optimización de imágenes, textos alternativos y traducción.",
      notes: {
        autoAssign: "Solo importa las imágenes de variante de Shopify",
        bulkUpload: "Carga sí, edición masiva desde Pro",
        combinedListings: "Vincula productos como muestras",
      },
    },
    "gg-image-slider": {
      kind: "App de galería deslizante para Shopify",
      summary:
        "GG Image Slider sustituye la galería de producto de su tema por un carrusel propio y puede mostrar solo las imágenes de la variante elegida. ContentPilot añade asignación automática, textos alternativos con IA y el resto de la suite. Así se comparan.",
      about:
        "GG Image Slider sustituye la galería de producto de su tema por un carrusel propio (miniaturas, zoom, lightbox, vídeo, 3D). Mostrar solo las imágenes de la variante elegida es una opción que depende del orden de sus medios en Shopify. El precio sigue su plan de Shopify.",
      strengths: [
        "Un carrusel configurable con zoom, lightbox y zoom con los dedos.",
        "Vídeos y modelos 3D, también en realidad aumentada.",
        "Pensado para deslizar en el móvil.",
        "Precio bajo.",
      ],
      ourEdge: [
        "Asignar imágenes en la app, arrastrando o automáticamente por nombre de archivo y SKU.",
        "Carga masiva con conversión a WebP.",
        "Textos alternativos con IA, traducidos a todos los idiomas de su tienda.",
        "Traducción, SEO y textos con IA en el mismo plan.",
      ],
      verdict:
        "Elija GG Image Slider si sobre todo quiere otra galería de producto. Elija ContentPilot si quiere galerías por variante junto con optimización de imágenes, textos alternativos y traducción.",
      notes: {
        noLayoutShift: "Anuncia carga asíncrona",
        autoAssign: "Por el orden de las imágenes",
        dragDrop: "Orden en el admin de Shopify",
        imageCompression: "Solo redimensionado",
      },
    },
  },
};
