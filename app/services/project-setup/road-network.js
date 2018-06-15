'use strict';

import config from '../../config';
import db from '../../db/';
import { setScenarioSetting } from '../../utils/utils';
import { createRoadNetworkVT } from '../../utils/vector-tiles';
import {
  getFileInfo,
  getFileContents,
  putFileStream
} from '../../s3/utils';
import { importRoadNetwork, removeDatabase } from '../rra-osm-p2p';
import * as overpass from '../../utils/overpass';
import { downloadWbCatalogScenarioFile, waitForEventsOnEmitter } from './common';

export default async function (projId, scId, {op, emitter, logger, appLogger}) {
  const source = await db('scenarios_source_data')
    .select('*')
    .where('scenario_id', scId)
    .where('name', 'road-network')
    .first();

  let fileData;
  if (source.type === 'wbcatalog') {
    fileData = await downloadWbCatalogScenarioFile(projId, scId, source, logger);
  }

  if (source.type === 'osm') {
    // If importing from OSM we need to wait for the admin bounds.
    const result = await waitForEventsOnEmitter(emitter, 'admin-bounds:data');
    const adminBoundsFc = result['admin-bounds:data'];
    fileData = await importOSMRoadNetwork(projId, scId, overpass.fcBbox(adminBoundsFc), op, logger);
  }

  if (source.type === 'file') {
    fileData = await db('scenarios_files')
      .select('*')
      .where('project_id', projId)
      .where('type', 'road-network')
      .first();
  }

  const fileInfo = await getFileInfo(fileData.path);

  // Remove the osm-p2p database.
  // Since the road network is handled before the pois it will take care
  // of doing the cleanup.
  await removeDatabase(projId, scId);

  // Disable road network editing if size over threshold.
  const allowImport = fileInfo.size < config.roadNetEditMax;
  await setScenarioSetting(db, scId, 'rn_active_editing', allowImport);

  if (allowImport) {
    const roadNetwork = await getFileContents(fileData.path);
    let rnLogger = appLogger.group(`p${projId} s${scId} rn import`);
    rnLogger && rnLogger.log('process road network');
    await importRoadNetwork(projId, scId, op, roadNetwork, rnLogger);
  }

  // Emitt after importing to avoid concurrency.
  emitter.emit('road-network:active-editing', allowImport);

  if (process.env.DS_ENV !== 'test') {
    await createRoadNetworkVT(projId, scId, op, fileData.path).promise;
  }
}

async function importOSMRoadNetwork (projId, scId, bbox, op, logger) {
  logger && logger.log('Importing road network from overpass for bbox (S,W,N,E):', bbox);

  await op.log('process:road-network', {message: 'Importing road network from OSM'});

  // Clean the tables so any remnants of previous attempts are removed.
  // This avoids primary keys collisions and duplication.
  await db('scenarios_files')
    .where('project_id', projId)
    .where('scenario_id', scId)
    .where('type', 'road-network')
    .del();

  let osmData;
  try {
    osmData = await overpass.importRoadNetwork(bbox);
  } catch (err) {
    // Just to log error
    logger && logger.log('Error importing from overpass', err.message);
    throw err;
  }

  logger && logger.log('Got road network. Saving to S3 and db');
  // Insert file into DB.
  let fileName = `road-network_${Date.now()}`;
  let filePath = `scenario-${scId}/${fileName}`;
  let data = {
    name: fileName,
    type: 'road-network',
    path: filePath,
    project_id: projId,
    scenario_id: scId,
    created_at: (new Date()),
    updated_at: (new Date())
  };

  await putFileStream(filePath, osmData);
  await db('scenarios_files').insert(data);
}