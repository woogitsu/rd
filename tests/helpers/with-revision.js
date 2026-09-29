// #215 etap 2: updateMeeting/updateResolution wymagają `revision`. Testy, które
// nie sprawdzają współbieżności, używają tych nakładek: działają jak klient,
// który tuż przed zapisem wczytał bieżący wiersz (revision_no z bazy), o ile
// wywołanie nie poda `revision` jawnie. Testy współbieżności wołają funkcje
// z src/pg/meetings.js bezpośrednio, z jawnym numerem wersji.
import {
  updateMeeting as updateMeetingRaw, updateResolution as updateResolutionRaw,
} from '../../src/pg/meetings.js';

async function currentRevision(db, table, id) {
  const { rows } = await db.query(`SELECT revision_no FROM ${table} WHERE id = $1`, [id]);
  return rows[0]?.revision_no;
}

export async function updateMeeting(db, actor, input = {}, env) {
  const revision = input.revision !== undefined ? input.revision : await currentRevision(db, 'meetings', input.meetingId);
  return updateMeetingRaw(db, actor, { ...input, revision }, env);
}

export async function updateResolution(db, actor, input = {}, env) {
  const revision = input.revision !== undefined ? input.revision : await currentRevision(db, 'resolutions', input.resolutionId);
  return updateResolutionRaw(db, actor, { ...input, revision }, env);
}
