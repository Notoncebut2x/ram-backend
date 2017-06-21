'use strict';
import Joi from 'joi';
import Boom from 'boom';
import Promise from 'bluebird';
import Zip from 'node-zip';
import _ from 'lodash';

import db from '../db/';
import { getFileContents } from '../s3/utils';
import { FileNotFoundError } from '../utils/errors';

export default [
  {
    path: '/projects/{projId}/scenarios/{scId}/results',
    method: 'GET',
    config: {
      validate: {
        params: {
          projId: Joi.number(),
          scId: Joi.number()
        },
        query: {
          download: Joi.boolean().truthy('true').falsy('false').valid('true').required(),
          type: Joi.string().valid(['csv', 'geojson']).required()
        }
      }
    },
    handler: (request, reply) => {
      const { projId, scId } = request.params;
      const { type } = request.query;

      db('scenarios_files')
        .select('*')
        .where('project_id', projId)
        .where('scenario_id', scId)
        .where('type', `results-${type}`)
        .then(files => {
          if (!files.length) throw new FileNotFoundError('Results not found');
          return files;
        })
        // Match file metadata with their content.
        .then(files => {
          return Promise.map(files, f => getFileContents(f.path))
            .then(filesData => files.map((f, i) => {
              f.content = filesData[i];
              return f;
            }));
        })
        // Zip the files.
        .then(files => {
          let zip = new Zip();
          files.forEach(f => {
            zip.file(`${f.name}.${type}`, f.content);
          });

          return zip.generate({ base64: false, compression: 'DEFLATE' });
        })
        // Send!
        .then(data => reply(data)
          .type('application/zip')
          .encoding('binary')
          .header('Content-Disposition', `attachment; filename=results-${type}-p${projId}s${scId}.zip`)
        )
        .catch(FileNotFoundError, e => reply(Boom.notFound(e.message)))
        .catch(err => {
          if (err.code === 'NoSuchKey') {
            return reply(Boom.notFound('File not found in storage bucket'));
          }
          console.log('err', err);
          reply(Boom.badImplementation(err));
        });
    }
  },
  {
    path: '/projects/{projId}/scenarios/{scId}/results/analysis',
    method: 'GET',
    config: {
      validate: {
        params: {
          projId: Joi.number(),
          scId: Joi.number()
        }
      }
    },
    handler: (request, reply) => {
      const { projId, scId } = request.params;

      // Future structure.
      // let r = {
      //   accessibilityTime: [
      //     {
      //       poi: 'bank',
      //       times: [10, 20, 30, 40, 50],
      //       adminAreas: [
      //         {
      //           name: 'something',
      //           indicators: [
      //             {
      //               name: 'Total Population',
      //               data: [0, 0, 0.1, 0.5, 1]
      //             }
      //           ]
      //         }
      //       ]
      //     }
      //   ]
      // };

      // Get all the poi types.
      let _poi = db('scenarios_files')
        .select('subtype')
        .where('type', 'poi')
        .where('project_id', projId)
        .where('scenario_id', scId);

      // Get all the admin areas for which results were generated.
      let _aa = db('scenarios_settings')
        .select('value')
        .where('key', 'admin_areas')
        .where('scenario_id', scId)
        .first()
        .then(aa => JSON.parse(aa.value))
        .then(selectedAA => db('projects_aa')
          .select('id', 'name')
          .where('project_id', projId)
          .whereIn('id', selectedAA)
        );

      // Generate the accessibilityTime array to be used later.
      let _accessibilityTime = Promise.all([_poi, _aa])
        .then(data => {
          let [poi, aa] = data;
          let accessibilityTime = poi.map(p => {
            return {
              poi: p.subtype,
              analysisMins: [10, 20, 30, 60, 90, 120],
              adminAreas: aa.map(a => {
                return {
                  id: a.id,
                  name: a.name
                };
              })
            };
          });

          return accessibilityTime;
        });

      // Get all the results.
      let _all = db.raw(`
        SELECT
          pop.value as pop_value,
          pop.key as pop_key,
          r.project_aa_id as aa_id,
          rp.type as poi_type,
          rp.time as time_to_poi,
          po.id as origin_id
        FROM results r
        INNER JOIN results_poi rp ON r.id = rp.result_id
        INNER JOIN projects_origins po ON po.id = r.origin_id
        INNER JOIN projects_origins_indicators pop ON po.id = pop.origin_id
        WHERE pop.key = 'population'
      `)
      .then(res => res.rows);

      // Sum by pop_value.
      const sumPop = (arr) => arr.reduce((acc, o) => acc + (parseInt(o.pop_value) || 1), 0);
      // Check if given time is less that given nimutes accounting for nulls.
      const isLessThanMinutes = (time, min) => time === null ? false : time <= min * 60;

      // Compute the results.
      Promise.all([_accessibilityTime, _all])
        .then(data => {
          let [accessibilityTime, all] = data;

          accessibilityTime = accessibilityTime.map(poi => {
            poi.adminAreas = _(poi.adminAreas).map(aa => {
              let filtered = all.filter(r => r.poi_type === poi.poi && r.aa_id === aa.id);

              if (filtered.length) {
                let totalPop = sumPop(filtered);
                let pop = poi.analysisMins.map(time => sumPop(filtered.filter(o => isLessThanMinutes(o.time_to_poi, time))));
                aa.data = pop.map(o => o / totalPop * 100);
              } else {
                aa.data = [];
              }

              return aa;
            })
            .sortBy(poi.adminAreas, o => _.deburr(o.name))
            .reverse()
            .value();

            return poi;
          });
          return accessibilityTime;
        })
        .then(accessibilityTime => {
          reply({accessibilityTime});
        }).catch(err => {
          console.log('err', err);
          reply(Boom.badImplementation(err));
        });
    }
  },
  {
    path: '/projects/{projId}/scenarios/{scId}/results/raw',
    method: 'GET',
    config: {
      validate: {
        params: {
          projId: Joi.number(),
          scId: Joi.number()
        },
        query: {
          sortBy: Joi.string(),
          sortDir: Joi.string().valid(['asc', 'desc']),
          limit: Joi.number().default(50),
          page: Joi.number()
        }
      }
    },
    handler: (request, reply) => {
      const { projId, scId } = request.params;
      const { page, limit } = request;
      const offset = (page - 1) * limit;
      let { sortBy, sortDir } = request.query;

      sortBy = sortBy || 'origin_name';
      sortDir = sortDir || 'asc';

      let _count = db('results')
        .count('projects_origins.id')
        .innerJoin('results_poi', 'results.id', 'results_poi.result_id')
        .innerJoin('projects_origins', 'projects_origins.id', 'results.origin_id')
        .innerJoin('projects_origins_indicators', 'projects_origins_indicators.origin_id', 'projects_origins.id')
        .innerJoin('projects_aa', 'projects_aa.id', 'results.project_aa_id')
        .where('results.project_id', projId)
        .where('results.scenario_id', scId)
        .where('projects_origins_indicators.key', 'population')
        .first();

      let _results = db('results')
        .select(
          'projects_origins.id as origin_id',
          'projects_origins.name as origin_name',
          'results.project_aa_id as aa_id',
          'projects_aa.name as aa_name',
          'projects_origins_indicators.value as pop_value',
          'projects_origins_indicators.key as pop_key',
          'results_poi.type as poi_type',
          'results_poi.time as time_to_poi'
        )
        .innerJoin('results_poi', 'results.id', 'results_poi.result_id')
        .innerJoin('projects_origins', 'projects_origins.id', 'results.origin_id')
        .innerJoin('projects_origins_indicators', 'projects_origins_indicators.origin_id', 'projects_origins.id')
        .innerJoin('projects_aa', 'projects_aa.id', 'results.project_aa_id')
        .where('results.project_id', projId)
        .where('results.scenario_id', scId)
        .where('projects_origins_indicators.key', 'population')
        .orderBy(sortBy, sortDir)
        .offset(offset).limit(limit);

      Promise.all([_count, _results])
        .then(res => {
          request.count = parseInt(res[0].count);
          reply(res[1]);
        }).catch(err => {
          console.log('err', err);
          reply(Boom.badImplementation(err));
        });
    }
  }
];
