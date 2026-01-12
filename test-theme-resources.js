// Test script to check all ONLINE_STORE_THEME_* resource types
// This will be added temporarily to ContentService to test what actually works

const THEME_RESOURCE_TYPES = [
  'ONLINE_STORE_THEME',
  'ONLINE_STORE_THEME_APP_EMBED',
  'ONLINE_STORE_THEME_JSON_TEMPLATE',
  'ONLINE_STORE_THEME_LOCALE_CONTENT',
  'ONLINE_STORE_THEME_SECTION_GROUP',
  'ONLINE_STORE_THEME_SETTINGS_CATEGORY',
  'ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS',
];

async function testAllThemeResourceTypes(admin) {
  console.log('\n\n=== 🧪 TESTING ALL THEME RESOURCE TYPES ===\n');

  const results = {};

  for (const resourceType of THEME_RESOURCE_TYPES) {
    console.log(`\n--- Testing: ${resourceType} ---`);

    try {
      const query = `#graphql
        query testThemeResource($first: Int!, $resourceType: TranslatableResourceType!) {
          translatableResources(first: $first, resourceType: $resourceType) {
            edges {
              node {
                resourceId
                translatableContent {
                  key
                  value
                  digest
                  locale
                }
              }
            }
          }
        }
      `;

      const response = await admin.graphql(query, {
        variables: { first: 10, resourceType }
      });

      const data = await response.json();

      if (data.errors) {
        console.log(`❌ ERROR:`, data.errors[0].message);
        results[resourceType] = { status: 'ERROR', error: data.errors[0].message };
        continue;
      }

      const resources = data.data?.translatableResources?.edges || [];
      const totalContent = resources.reduce((sum, r) => sum + (r.node.translatableContent?.length || 0), 0);

      console.log(`✅ SUCCESS`);
      console.log(`   Resources found: ${resources.length}`);
      console.log(`   Total translatable content: ${totalContent}`);

      if (resources.length > 0 && totalContent > 0) {
        console.log(`   Sample keys:`, resources[0].node.translatableContent.slice(0, 3).map(c => c.key));
      }

      results[resourceType] = {
        status: 'SUCCESS',
        resourceCount: resources.length,
        contentCount: totalContent,
        hasContent: totalContent > 0
      };

    } catch (error) {
      console.log(`❌ EXCEPTION:`, error.message);
      results[resourceType] = { status: 'EXCEPTION', error: error.message };
    }
  }

  console.log('\n\n=== 📊 SUMMARY ===\n');
  console.log('Resource Types with actual content:');

  for (const [type, result] of Object.entries(results)) {
    if (result.status === 'SUCCESS' && result.hasContent) {
      console.log(`✅ ${type}: ${result.resourceCount} resources, ${result.contentCount} translatable fields`);
    }
  }

  console.log('\nResource Types with no content:');
  for (const [type, result] of Object.entries(results)) {
    if (result.status === 'SUCCESS' && !result.hasContent) {
      console.log(`⚠️  ${type}: ${result.resourceCount} resources, but 0 translatable fields`);
    }
  }

  console.log('\nResource Types with errors:');
  for (const [type, result] of Object.entries(results)) {
    if (result.status !== 'SUCCESS') {
      console.log(`❌ ${type}: ${result.error}`);
    }
  }

  console.log('\n=== 🧪 TEST COMPLETE ===\n\n');

  return results;
}

// Export for use in ContentService
module.exports = { testAllThemeResourceTypes };
