/**
 * Mapping aid: prints each dataset's CSV columns with a sample value, reading only the
 * first row of the current season's file. No database needed.
 * Usage: npm run headers -- [--dataset name]...
 */
import { parseArgs } from 'node:util';
import { datasets } from '../modules/pipeline/service/datasets.js';
import { openCsv, sourceUrl } from '../modules/pipeline/service/nflverse.service.js';
import { currentSeason, SINGLE_FILE_SEASON } from '../modules/pipeline/service/season.js';

const { values } = parseArgs({ options: { dataset: { type: 'string', multiple: true } } });
const selected = datasets.filter((d) => !values.dataset || values.dataset.includes(d.name));

for (const def of selected) {
  const url = sourceUrl(def, def.scope === 'single_file' ? SINGLE_FILE_SEASON : currentSeason(def.rollover));
  console.log(`\n== ${def.name}\n   ${url}`);
  try {
    const records = await openCsv(url, def.gzip);
    for await (const record of records) {
      const columns = Object.keys(record);
      console.log(`   ${columns.length} columns`);
      for (const c of columns) console.log(`   ${c} = ${record[c]}`);
      break;
    }
  } catch (err) {
    console.error(`   could not read: ${err instanceof Error ? err.message : String(err)}`);
  }
}
