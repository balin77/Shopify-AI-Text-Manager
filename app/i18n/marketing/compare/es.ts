import type { CompareCopy } from "./types";

export const compareEs: CompareCopy = {
  title: "ContentPilot frente a otras apps de traducción para Shopify",
  intro:
    "Cómo se compara ContentPilot AI con Translate & Adapt, Weglot, Transcy y LangShop: qué hace bien cada app, en qué se diferencian y cuál encaja con cada tienda.",
  vsTitle: "ContentPilot vs. {name}",
  vsMetaTitle: "ContentPilot vs. {name}: apps de traducción para Shopify comparadas",
  tableHeading: "Función por función",
  featureColumn: "Función",
  support: {
    yes: "Sí",
    partial: "En parte",
    no: "No",
    unstated: "Sin datos",
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
  ourNotes: {
    autoTranslate: "Con su propia clave de IA",
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
    "La tabla muestra si una app ofrece una función. En todos los proveedores, incluido el nuestro, algunas funciones solo llegan con un plan de pago: la comparación de precios de abajo muestra qué incluye cada plan.",
  pricing: {
    heading: "Comparación de precios",
    intro: "Todos los planes de todas las apps, uno al lado del otro. Lo que incluye cada plan es lo que indica el propio proveedor.",
    perMonth: "/ mes",
    free: "Gratis",
    note: "Precios mensuales en la moneda de cada proveedor, sin impuestos. Varios proveedores son más baratos con pago anual. Con ContentPilot usa su propia clave de IA, así que el uso de IA lo factura aparte su proveedor de IA.",
    summaries: {
      contentpilot: "Precio según el tamaño del catálogo. Idiomas ilimitados en todos los planes.",
      "translate-and-adapt": "Gratuita. Traducción automática para dos idiomas; los demás, a mano.",
      weglot: "Precio según idiomas y palabras traducidas. Prueba gratuita de 14 días; algunos costes los factura Weglot fuera de la factura de Shopify.",
      transcy: "Precio según idiomas, monedas y tokens de IA. Prueba gratuita de 7 días en los planes de pago.",
      langshop: "Precio según idiomas y número de productos. Prueba gratuita de 14 días en los planes de pago.",
    },
    plans: {
      contentpilot: {
        free: "50 productos, 5 colecciones, todos los idiomas",
        basic: "100 productos, 50 colecciones, 20 páginas, políticas, imágenes de producto, opciones y metacampos",
        pro: "500 productos, blogs, textos del tema y del checkout, menús, metaobjetos, instrucciones propias para la IA, galerías por variante",
        max: "2.500 productos, textos de otras apps, retraducción automática cuando cambian los textos, revisión semanal del sitio",
      },
      "translate-and-adapt": {
        free: "Traducción automática a dos idiomas; los demás idiomas, a mano",
      },
      weglot: {
        free: "1 idioma, 2.000 palabras",
        starter: "1 idioma, 10.000 palabras",
        business: "3 idiomas, 50.000 palabras",
        pro: "5 idiomas, 250.000 palabras",
      },
      transcy: {
        free: "1 idioma, 1 moneda, palabras ilimitadas, textos de otras apps",
        localPlus: "1 idioma editable, 1 moneda, motores de IA, 150 tokens de IA al mes, SEO multilingüe",
        regional: "3 idiomas (2 editables), 300 tokens de IA al mes, 3 monedas, 20 entradas de glosario, traducción automática, 10 imágenes por idioma",
        continental: "15 idiomas (10 editables), 500 tokens de IA al mes, 15 monedas, 200 entradas de glosario, detección de ubicación, clave propia de DeepL/OpenAI/Gemini",
      },
      langshop: {
        free: "1 idioma, 50 productos, sin límite de palabras, SEO multilingüe, selector básico",
        basic: "1 idioma, 250 productos, 5 reglas de glosario, edición masiva de traducciones, sin marca LangShop",
        standard: "3 idiomas, 2.000 productos, 100 reglas de glosario, sincronización automática, DeepL Pro/OpenAI/Google Cloud, textos de otras apps",
        advanced: "5 idiomas, 5.000 productos, 250 reglas de glosario, reglas de exclusión, Shopify Flow",
      },
    },
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
        "Encaja bien si solo necesita uno o dos idiomas más y traduce poco.",
      ],
      ourEdge: [
        "Traducción con IA en todos los idiomas que quiera, con su propio tono y sus reglas.",
        "Un glosario, para que los nombres de marca y términos fijos nunca se traduzcan mal.",
        "Traduce textos de otras apps, como los widgets de reseñas.",
        "Actualiza las traducciones automáticamente cuando cambia el texto original.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas y un editor de hoja de cálculo para todo el catálogo.",
      ],
      verdict:
        "Quédese con Translate & Adapt si vende en uno o dos idiomas adicionales y cambia sus textos pocas veces. Elija ContentPilot si quiere más idiomas, términos coherentes o una sola app para textos, SEO y traducciones. Ambas guardan en el almacén de traducciones de Shopify, así que puede cambiar cuando quiera y conservar todo.",
      notes: {
        autoTranslate: "Dos idiomas",
        imagesPerLanguage: "Solo imágenes del tema",
      },
    },
    weglot: {
      kind: "Servicio de traducción para muchas plataformas web",
      summary:
        "Weglot traduce sitios web en muchas plataformas y cobra por palabras traducidas. ContentPilot funciona dentro de Shopify, guarda las traducciones en su tienda y añade herramientas SEO y de contenido. Así se comparan.",
      about:
        "Weglot es un servicio de traducción para muchas plataformas web, entre ellas Shopify. Detecta los textos de su tienda y sirve las páginas traducidas a través de su propio sistema. Los planes dependen del número de idiomas y de palabras traducidas.",
      strengths: [
        "Producto maduro con un editor visual que muestra las traducciones en la página.",
        "Glosario y una IA que aprende la voz de su marca.",
        "Traduce textos de otras apps y cambia imágenes por idioma.",
        "Traducción profesional humana opcional.",
      ],
      ourEdge: [
        "Las traducciones se guardan en su tienda Shopify y se conservan si desinstala la app.",
        "Idiomas ilimitados en todos los planes y sin límite de palabras; los planes se miden por número de productos.",
        "Usted elige el proveedor de IA y le paga directamente, a precio de coste.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas, visibilidad en búsquedas con IA y un editor de hoja de cálculo para todo el catálogo.",
      ],
      verdict:
        "Elija Weglot si tiene sitios en varias plataformas y quiere un único servicio de traducción para todos, o si necesita traductores profesionales. Elija ContentPilot si su tienda funciona con Shopify, quiere que las traducciones pertenezcan a su tienda y no quiere límites de palabras.",
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
        "Idiomas ilimitados en todos los planes.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas y visibilidad en búsquedas con IA.",
        "Un editor de hoja de cálculo para todo el catálogo y galerías de imágenes por variante.",
      ],
      verdict:
        "Elija Transcy si necesita un conversor de moneda más allá de Shopify Markets o traducir el texto dentro de las imágenes. Elija ContentPilot si quiere traducciones con su propio tono y una sola app para textos, SEO y traducciones.",
      notes: {
        aiProvider: "Varios motores",
      },
    },
    langshop: {
      kind: "App de traducción para Shopify",
      summary:
        "LangShop traduce tiendas Shopify con varios motores de IA y ofrece conversión de moneda. ContentPilot añade herramientas SEO, redacción de contenido e idiomas ilimitados en todos los planes. Así se comparan.",
      about:
        "LangShop es una app de traducción para Shopify que trabaja con varios motores de IA o con traductores humanos. Cubre la tienda, el checkout y los textos de otras apps, e incluye un conversor de moneda y un selector de idioma.",
      strengths: [
        "Muchísimos idiomas, incluidos los que se escriben de derecha a izquierda.",
        "Varios motores de IA y traducción humana opcional.",
        "Glosario y reglas de traducción propias.",
        "Conversión de moneda y selector de idioma.",
      ],
      ourEdge: [
        "Idiomas ilimitados en todos los planes.",
        "Usted elige el proveedor de IA y le paga directamente, a precio de coste.",
        "Escribe y mejora textos de producto, títulos SEO y textos alternativos.",
        "Herramientas SEO completas y visibilidad en búsquedas con IA.",
        "Un editor de hoja de cálculo para todo el catálogo y galerías de imágenes por variante.",
      ],
      verdict:
        "Elija LangShop si quiere traductores humanos a su disposición o un conversor de moneda más allá de Shopify Markets. Elija ContentPilot si quiere idiomas ilimitados y una sola app para textos, SEO y traducciones.",
      notes: {
        aiProvider: "Varios motores",
        bulkEditor: "Solo traducciones",
      },
    },
  },
};
