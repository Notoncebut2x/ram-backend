'use strict';
import { assert } from 'chai';

import Server from '../app/services/server';
import db from '../app/db';
import { setupStructure as setupDdStructure } from '../app/db/structure';
import { setupStructure as setupStorageStructure } from '../app/s3/structure';
import { fixMeUp, projectPendingWithFiles, projectPendingWithAllFiles } from './utils/data';

var options = {
  connection: {port: 2000, host: '0.0.0.0'}
};

var instance;
before(function (done) {
  instance = Server(options).hapi;
  instance.register(require('inject-then'), function (err) {
    if (err) throw err;
    done();
  });
});

describe('Projects', function () {
  before('Before - Projects', function (done) {
    setupDdStructure()
      .then(() => setupStorageStructure())
      .then(() => fixMeUp())
      .then(() => done());
  });

  describe('GET /projects', function () {
    it('should return projects', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.meta.found, 8);
        assert.equal(result.results[0].name, 'Project 1000');
      });
    });

    it('should return 1 project', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects?limit=1&page=2'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.meta.found, 8);
        assert.equal(result.results[0].id, 1002);
        assert.equal(result.results[0].status, 'pending');
        assert.equal(result.results[0].name, 'Project 1002');
      });
    });

    it('should include the scenario count for a project', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(res.result.results[0].id, 1000);
        assert.equal(res.result.results[0].scenarioCount, 1);
      });
    });

    it('should not include readyToEndSetup flag', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(typeof res.result.results[0].readyToEndSetup, 'undefined');
      });
    });
  });

  describe('GET /projects/{projId}', function () {
    it('should return not found when getting non existent project', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects/300'
      }).then(res => {
        assert.equal(res.statusCode, 404, 'Status code is 404');
      });
    });

    it('should return the correct project', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects/1000'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(res.result.id, 1000);
        assert.equal(res.result.name, 'Project 1000');
      });
    });

    it('should include the scenario count for an individual project', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects/1200'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(res.result.id, 1200);
        assert.equal(res.result.scenarioCount, 2);
      });
    });

    it('should include readyToEndSetup flag with false', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects/1000'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(res.result.readyToEndSetup, false);
      });
    });

    it('should include readyToEndSetup flag with true', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects/1004'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(res.result.readyToEndSetup, true);
      });
    });

    it('should include readyToEndSetup flag with true even for active project', function () {
      return instance.injectThen({
        method: 'GET',
        url: '/projects/1200'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(res.result.status, 'active');
        assert.equal(res.result.readyToEndSetup, true);
      });
    });
  });

  describe('DELETE /projects/{projId}', function () {
    before(function (done) {
      // Insert an entry on every table to ensure delete works.
      // Use just the needed fields.
      projectPendingWithFiles(99999)
      .then(() => done());
    });

    it('should return not found when deleting non existent project', function () {
      return instance.injectThen({
        method: 'DELETE',
        url: '/projects/10'
      }).then(res => {
        assert.equal(res.statusCode, 404, 'Status code is 404');
      });
    });

    it('should delete a project and all related scenarios and files', function () {
      return instance.injectThen({
        method: 'DELETE',
        url: '/projects/99999'
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        assert.equal(res.result.message, 'Project deleted');

        return db.select('*')
          .from('scenarios')
          .where('project_id', 99999)
          .then(scenarios => {
            assert.equal(scenarios.length, 0);
            return;
          })
          .then(() => db.select('*')
            .from('projects_files')
            .where('project_id', 99999)
            .then(files => {
              assert.equal(files.length, 0);
            })
          )
          .then(() => db.select('*')
            .from('scenarios_files')
            .where('project_id', 99999)
            .then(files => {
              assert.equal(files.length, 0);
            })
          );
      });
    });
  });

  describe('POST /projects', function () {
    it('should fail when creating a project without a name', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects',
        payload: {
        }
      }).then(res => {
        assert.equal(res.statusCode, 400, 'Status code is 400');
        var result = res.result;
        assert.match(result.message, /['name' is required]/);
      });
    });

    it('should create a project with just the name', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects',
        payload: {
          name: 'Project created'
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.name, 'Project created');
        assert.equal(result.status, 'pending');
        assert.equal(result.description, null);
      });
    });

    it('should return a conflict when creating a project with the same name', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects',
        payload: {
          name: 'Project created'
        }
      }).then(res => {
        assert.equal(res.statusCode, 409, 'Status code is 409');
        var result = res.result;
        assert.equal(result.message, 'Project name already in use: Project created');
      });
    });

    it('should create a project with all properties', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects',
        payload: {
          name: 'Project with all properties',
          description: 'This is the description'
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.name, 'Project with all properties');
        assert.equal(result.description, 'This is the description');
      });
    });
  });

  describe('PATCH /projects/{projId}', function () {
    it('should return not found when patching a non existent project', function () {
      return instance.injectThen({
        method: 'PATCH',
        url: '/projects/10',
        payload: {
        }
      }).then(res => {
        assert.equal(res.statusCode, 404, 'Status code is 404');
      });
    });

    it('should return a conflict when setting a name that already exists', function () {
      return instance.injectThen({
        method: 'PATCH',
        url: '/projects/1000',
        payload: {
          name: 'Project 1100'
        }
      }).then(res => {
        assert.equal(res.statusCode, 409, 'Status code is 409');
        var result = res.result;
        assert.equal(result.message, 'Project name already in use: Project 1100');
      });
    });

    it('should not accept an empty name', function () {
      return instance.injectThen({
        method: 'PATCH',
        url: '/projects/1000',
        payload: {
          name: ''
        }
      }).then(res => {
        assert.equal(res.statusCode, 400, 'Status code is 400');
        var result = res.result;
        assert.match(result.message, /['name' is not allowed to be empty]/);
      });
    });

    it('should change the project name', function () {
      return instance.injectThen({
        method: 'PATCH',
        url: '/projects/1000',
        payload: {
          name: 'New name'
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.name, 'New name');
      });
    });

    it('should not accept an empty description', function () {
      return instance.injectThen({
        method: 'PATCH',
        url: '/projects/1000',
        payload: {
          description: ''
        }
      }).then(res => {
        assert.equal(res.statusCode, 400, 'Status code is 400');
        var result = res.result;
        assert.match(result.message, /['description' is not allowed to be empty]/);
      });
    });

    it('should accept a null description', function () {
      return instance.injectThen({
        method: 'PATCH',
        url: '/projects/1000',
        payload: {
          description: null
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.description, null);
      });
    });

    it('should update all values', function () {
      return instance.injectThen({
        method: 'PATCH',
        url: '/projects/1000',
        payload: {
          name: 'updated name',
          description: 'updated description'
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.name, 'updated name');
        assert.equal(result.description, 'updated description');
        assert.equal((new Date(result.created_at)).toISOString(), '2017-02-01T12:00:01.000Z');
        assert.notEqual(result.created_at, result.updated_at);
      });
    });
  });

  describe('POST /projects/{projId}/finish-setup', function () {
    before(function (done) {
      // Needed for test: 'should update project and scenario with name and description'
      projectPendingWithAllFiles(19999)
        .then(() => done());
    });

    it('should return a conflict when finishing setup for an active project', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects/1200/finish-setup',
        payload: {
          scenarioName: 'Main scenario'
        }
      }).then(res => {
        assert.equal(res.statusCode, 409, 'Status code is 409');
        var result = res.result;
        assert.equal(result.message, 'Project setup already completed');
      });
    });

    it('should return a conflict when finishing setup for a project not ready', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects/1000/finish-setup',
        payload: {
          scenarioName: 'Main scenario'
        }
      }).then(res => {
        assert.equal(res.statusCode, 409, 'Status code is 409');
        var result = res.result;
        assert.equal(result.message, 'Project preconditions to finish setup not met');
      });
    });

    it('should return 404 when finishing setup for a non existent project', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects/300/finish-setup',
        payload: {
          scenarioName: 'Main scenario'
        }
      }).then(res => {
        assert.equal(res.statusCode, 404, 'Status code is 404');
        var result = res.result;
        assert.equal(result.message, 'Project not found');
      });
    });

    it('should update project and scenario with name', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects/1004/finish-setup',
        payload: {
          scenarioName: 'Main scenario'
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.message, 'Project setup finished');

        // Check the db for updates.
        return Promise.all([
          db('projects')
            .where('id', 1004)
            .then(proj => {
              assert.equal(proj[0].status, 'active');
            }),
          db('scenarios')
            .where('project_id', 1004)
            .then(scenario => {
              assert.equal(scenario[0].status, 'active');
              assert.equal(scenario[0].name, 'Main scenario');
              let adminAreas = [
                {'name': 'Distrito de Abadia', 'selected': false},
                {'name': 'Distrito de Itanhi', 'selected': false},
                {'name': 'Distrito de Conceição de Campinas', 'selected': false},
                {'name': 'Distrito de Sambaíba', 'selected': false},
                {'name': 'Distrito de Buril', 'selected': false},
                {'name': 'Distrito de Itamira', 'selected': false},
                {'name': 'Estância', 'selected': false},
                {'name': 'Itaporanga d\'Ajuda', 'selected': false},
                {'name': 'Salgado', 'selected': false},
                {'name': 'Arauá', 'selected': false},
                {'name': 'Boquim', 'selected': false},
                {'name': 'Cristinápolis', 'selected': false},
                {'name': 'Indiaroba', 'selected': false},
                {'name': 'Itabaianinha', 'selected': false},
                {'name': 'Pedrinhas', 'selected': false},
                {'name': 'Santa Luzia do Itanhy', 'selected': false},
                {'name': 'Tomar do Geru', 'selected': false},
                {'name': 'Umbaúba', 'selected': false},
                {'name': 'Pedra Mole', 'selected': false},
                {'name': 'Campo do Brito', 'selected': false},
                {'name': 'Itabaiana', 'selected': false},
                {'name': 'Lagarto', 'selected': false},
                {'name': 'Macambira', 'selected': false},
                {'name': 'Poço Verde', 'selected': false},
                {'name': 'Simão Dias', 'selected': false},
                {'name': 'São Domingos', 'selected': false},
                {'name': 'Palmares', 'selected': false},
                {'name': 'Riachão do Dantas', 'selected': false},
                {'name': 'Samambaia', 'selected': false},
                {'name': 'Tobias Barreto', 'selected': false}
              ];
              assert.deepEqual(scenario[0].admin_areas, adminAreas);
            })
        ]);
      });
    });

    it('should update project and scenario with name and description', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects/19999/finish-setup',
        payload: {
          scenarioName: 'Main scenario updated',
          scenarioDescription: 'Main scenario description'
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');
        var result = res.result;
        assert.equal(result.message, 'Project setup finished');

        // Check the db for updates.
        return Promise.all([
          db('projects')
            .where('id', 19999)
            .then(proj => {
              assert.equal(proj[0].status, 'active');
            }),
          db('scenarios')
            .where('project_id', 19999)
            .then(scenario => {
              assert.equal(scenario[0].status, 'active');
              assert.equal(scenario[0].name, 'Main scenario updated');
              assert.equal(scenario[0].description, 'Main scenario description');
            })
        ]);
      });
    });
  });

  describe('other', function () {
    it('should create a pending scenario in the database', function () {
      return instance.injectThen({
        method: 'POST',
        url: '/projects',
        payload: {
          name: 'A new project'
        }
      }).then(res => {
        assert.equal(res.statusCode, 200, 'Status code is 200');

        return db.select('*')
          .from('scenarios')
          .where('project_id', res.result.id)
          .then(scenarios => {
            assert.equal(scenarios.length, 1);
            assert.equal(scenarios[0].status, 'pending');
          });
      });
    });
  });
});