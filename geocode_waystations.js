/**
 * geocode_waystations.js
 * Run: node geocode_waystations.js
 *
 * Geocodes confirmed Green Bay Monarch Waystation addresses via Nominatim
 * and writes the result to waystation_coords.json
 */

const https  = require('https');
const fs     = require('fs');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'HabitatMap/1.0 geocode_waystations' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${body.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function nominatim(address) {
  const enc = encodeURIComponent(address);
  const hits = await fetch(`https://nominatim.openstreetmap.org/search?q=${enc}&format=json&limit=1&countrycodes=us`);
  if (hits.length > 0) return { lat: +hits[0].lat, lon: +hits[0].lon, source: 'nominatim' };
  return null;
}

// ── Waystations to geocode: [id, registrant, habitatName, address, city, state, zip, type, location]
const entries = [
  // ── Public / institutional ────────────────────────────────────────────────
  { id: 4101,  reg: 'N.E.W. Zoological Society, Inc.',                     habitat: 'New Zoo Butterfly Garden',                          addr: 'NEW Zoo & Adventure Park, 4378 Reforestation Rd, Brown Deer, WI 54313', type: 'zoo' },
  { id: 7455,  reg: 'N.E.W. Master Gardener Volunteer Association',        habitat: 'Community Treatment Center Butterfly Garden',        addr: '3150 Gershwin Dr, Green Bay, WI 54311', type: 'org' },
  { id: 12514, reg: 'Bay Beach Wildlife Sanctuary',                        habitat: 'OAK School Garden',                                  addr: '1660 East Shore Dr, Green Bay, WI 54302', type: 'nature_center' },
  { id: 33669, reg: 'Wequiock Elementary School Children\'s Center for Environmental Science', habitat: 'Wequiock Elementary School',   addr: '4824 Wahl Rd, Green Bay, WI 54311', type: 'school' },
  { id: 18367, reg: 'Parish & Father Allouez Catholic School Resurrection Catholic', habitat: '', addr: '333 Hilltop Dr, Green Bay, WI 54301', type: 'place_of_worship' },
  { id: 43980, reg: 'Mahon Creek Neighborhood Association',                habitat: 'Mahon Creek Pollinator Garden',                      addr: 'Mahon Creek Park, Green Bay, WI 54311', type: 'community' },

  // ── Private home – confirmed by parcel first-name match ───────────────────
  { id: 3934,  reg: 'Diana & Dick Rockhill',        habitat: 'Rockhill Butterfly Buffet & Nursery',   addr: '1752 Condor Ln, Green Bay, WI 54313', type: 'home' },
  { id: 4017,  reg: 'Janet M. Hinkfuss',            habitat: '',                                       addr: '846 Ninth St, Green Bay, WI 54304', type: 'home' },
  { id: 4306,  reg: 'Lori and Bob Casey',           habitat: 'Windy Rock Pines',                       addr: '2385 Autumn Ridge Trl, Suamico, WI 54313', type: 'home' },
  { id: 5860,  reg: 'Dave Rotter',                  habitat: "Rielly's Retreat",                       addr: '513 Cornelius Dr, Green Bay, WI 54311', type: 'home' },
  { id: 8768,  reg: 'Julie Macier',                 habitat: "Grammy's Waystation",                    addr: '2470 Newberry Ave, Green Bay, WI 54302', type: 'home' },
  { id: 12790, reg: 'Sarah, Mark, Gwendolyn, Judah, and Leopoldo Valentine', habitat: 'Valentine Homestead', addr: '3026 Nicolet Dr, Green Bay, WI 54311', type: 'home' },
  { id: 26833, reg: 'Ann & Doug Wichman',           habitat: 'Pollinator Prairie',                     addr: '2867 Josephine Cir, Green Bay, WI 54311', type: 'home' },
  { id: 28310, reg: 'Susan Bartlett',               habitat: "Bartlett's Butterflies",                 addr: '1107 Forest Grove, Green Bay, WI 54313', type: 'home' },
  { id: 35044, reg: 'Michele Utrie',                habitat: "Michele's Monarchs",                     addr: '3240 Eaton Rd, Green Bay, WI 54311', type: 'home' },
  { id: 35594, reg: 'Donna Semrau',                 habitat: 'No Sweat Ranch',                         addr: '4511 Nicolet Dr, Green Bay, WI 54311', type: 'home' },
  { id: 39155, reg: 'Jessica and Nikolas Meurett',  habitat: 'The Shire',                              addr: '1308 Eliza St, Green Bay, WI 54301', type: 'home' },
  { id: 40470, reg: 'Brian Klawitter',              habitat: "Napalm's Wildflower Patch",              addr: '1434 Thirteenth Ave, Green Bay, WI 54304', type: 'home' },
  { id: 40790, reg: 'Steve & Veronica Krenek',      habitat: 'Misty Mountains Monarchs',               addr: '2064 Mystic Hills Ter, Suamico, WI 54313', type: 'home' },
  { id: 40818, reg: 'Jeremy & Carol Voldsness',     habitat: "Voldsness' Roost on the Hill",           addr: '2681 S Webster Ave, Green Bay, WI 54301', type: 'home' },
  { id: 45890, reg: 'Dave & Leigh Begalske',        habitat: "Begalske's House of Wings",              addr: '1823 Fiesta Ln, Green Bay, WI 54302', type: 'home' },
  { id: 46881, reg: 'Randy and Julie Gummin',       habitat: "Jewel's Haven",                          addr: '2298 Westline Rd, Suamico, WI 54313', type: 'home' },
  { id: 48804, reg: 'Randy & Debbie Rosera',        habitat: 'Rosera Gardens!',                        addr: '2575 Robinson Ave, Green Bay, WI 54311', type: 'home' },
  { id: 42976, reg: 'Sue Cravillion',               habitat: 'Cravillion Park',                        addr: '3701 Robin Ln, Suamico, WI 54313', type: 'home' },
];

(async () => {
  const results = [];
  for (const e of entries) {
    process.stdout.write(`[${e.id}] ${e.addr} ... `);
    const coords = await nominatim(e.addr);
    if (coords) {
      console.log(`✓  ${coords.lat}, ${coords.lon}`);
      results.push({ ...e, lat: coords.lat, lon: coords.lon });
    } else {
      console.log('✗  not found');
    }
    await sleep(1200); // Nominatim rate limit: 1 req/sec
  }

  fs.writeFileSync('waystation_coords.json', JSON.stringify(results, null, 2));
  console.log(`\nWritten ${results.length}/${entries.length} entries to waystation_coords.json`);
})();
