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
  ourNotes: {
    autoTranslate: "Con su propia clave de IA o con IA incluida",
    aiProvider: "Seis proveedores",
    imagesPerLanguage: "Aún no",
    currency: "Lo hace Shopify Markets",
  },
  aboutHeading: "Cómo funciona {name}",
  strengthsHeading: "Dónde destaca {name}",
  ourEdgeHeading: "Lo que añade ContentPilot",
  verdictHeading: "¿Cuál le conviene?",
  checkedAt: "septiembre de 2026",
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
    enginesLabel: "Proveedores de IA",
    engines: {
      ownKey: "{list}: con su propia clave",
      plusOwnKey: "Clave propia: {list}",
      shopify: "Traducción automática de Shopify",
      vendor: "IA propia del proveedor, no seleccionable",
      unstated: "Traducción automática, motor no indicado",
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
    addApp: "Añadir una aplicación a la comparación",
    removeApp: "Quitar {name} de la comparación",
    strengthsGroup: "Puntos fuertes",
    strengthsRow: "Dónde destaca la aplicación",
    strengthsHelp: "Según la información del proveedor, resumida por nosotros.",
    values: {
      unlimited: "Ilimitados",
      shopifyMax: "Todos los que permite Shopify (hasta 20)",
      someAutomatic: "2 automáticos, los demás a mano",
      automaticOf: "{auto} con IA, hasta {total} en total",
      manualOnly: "Solo traducción manual",
      wordsOnce: "{n} palabras una sola vez, más en paquetes de palabras",
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
  },
};
