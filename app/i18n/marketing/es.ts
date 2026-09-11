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
    videos: "Vídeos",
    faq: "Preguntas",
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
    ctaSecondary: "Ver los vídeos",
    note: "Funciona con su tema actual. Nunca modifica el código de su tema.",
  },

  pillars: {
    more: "Ver todas las funciones",
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

  media: {
    placeholder: "Imagen pendiente",
    alt: {
      hero: "El editor masivo: unos cientos de productos en una hoja, varios idiomas uno junto a otro",
      "pillar-writes": "El editor de contenido con una sugerencia de la IA en el campo de descripción",
      "pillar-translates": "La barra de idiomas de un producto con todos los idiomas publicados y una variante de mercado",
      "pillar-found": "El informe on-page tras un rastreo de la tienda, con los hallazgos agrupados por categoría",
      "feature-ai": "Un campo con un texto generado y el botón de aceptar al lado",
      "feature-translations": "La página 'añadir traducciones que faltan' con las casillas por idioma",
      "feature-bulk": "La cuadrícula del editor masivo con un filtro aplicado y unas celdas editadas resaltadas",
      "feature-seo": "El informe de rastreo: enlaces rotos, cadenas de redirección e indexabilidad en una vista",
      "feature-aeo": "La sección de descubrimiento para IA con agents.md, llms.txt y el estado de los datos estructurados",
      "feature-media": "El gestor de imágenes con textos alternativos en varios idiomas",
      "feature-structure": "El editor de menús con un árbol de navegación anidado",
    },
  },

  videos: {
    title: "Vídeos",
    intro:
      "Recorridos breves por las partes que cuesta explicar en una frase. Se están grabando más.",
    comingSoon: "Grabación en curso",
    comingSoonBody: "Este recorrido aún no está publicado.",
    play: "Reproducir",
    loadExternal: "Cargar y reproducir",
    externalNote:
      "Al reproducirlo, el vídeo se carga desde un proveedor externo que puede usar cookies.",
    items: {
      overview: {
        title: "Un recorrido por la aplicación",
        body: "Qué secciones hay, dónde vive su contenido y qué ocurre al guardar.",
      },
      "bulk-editor": {
        title: "Editar un catálogo entero de una vez",
        body: "Filtrar hasta las filas que importan, cambiar cientos de celdas y volver a importar un CSV.",
      },
      translations: {
        title: "Traducir una tienda",
        body: "Rellenar los idiomas que faltan, la redacción por mercado y qué pasa cuando cambia un texto de origen.",
      },
      seo: {
        title: "Rastrear su propia tienda",
        body: "Lanzar el análisis, leer el informe on-page y arreglar lo que encuentra sin salir de la aplicación.",
      },
      aeo: {
        title: "Ser legible para los asistentes de IA",
        body: "agents.md, llms.txt y datos estructurados — qué son y por qué ahora cuentan.",
      },
    },
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

  faq: {
    title: "Preguntas",
    items: [
      {
        q: "¿Modifica mi tema?",
        a: "No. La aplicación nunca edita el código de su tema — sin marcado inyectado, sin secciones reescritas, sin retoques de rendimiento en archivos que usted escribió. Los únicos archivos de tema que toca son los que ella misma creó (sus archivos de descubrimiento para IA y sus propios bloques de tienda), y puede devolver cada uno de ellos.",
      },
      {
        q: "¿Qué proveedor de IA usa?",
        a: "El que usted conecte: Anthropic, OpenAI, Gemini, DeepSeek, Grok o HuggingFace. Usted aporta su propia clave, así que el coste y la elección del modelo siguen siendo suyos.",
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
