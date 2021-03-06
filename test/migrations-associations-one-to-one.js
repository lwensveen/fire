/* global describe, afterEach, beforeEach, it */
'use strict';

var fire = require('..');
var Migrations = require('./../lib/modules/migrations');
var assert = require('assert');
var Q = require('q');

describe('migrations associations one-to-one', function() {
    var app = null;
	var models = null;
    var migrations = null;

    afterEach(function(done) {
        migrations.destroyAllModels()
            .then(function() {
                return fire.stop();
            })
            .then(function() {
                var defer = Q.defer();
                app.models.datastore.knex.destroy(defer.makeNodeResolver());
                return defer.promise;
            })
            .then(function() {
                done();
            })
            .catch(function(error) {
                done(error);
            })
            .done();
    });

    beforeEach(function() {
        app = fire.app('migrations', {});

        app.modules.forEach(function(module_) {
            if(module_.migrate) {
                module_.migrate(app.models);
            }
        });

        return fire.start()
            .then(function() {
                models = app.models;

                migrations = new Migrations(app, models);
                return migrations.setup(null)
                    .then(function() {
                        return models.Schema.exists()
                            .then(function(exists) {
                                return !exists && models.Schema.setup();
                            });
                    })
                    .then(function() {
                        return models.Schema.removeAll();
                    });
            });
    });

    it('can create 1:1 association', function(done) {
    	function Migration() {}
    	Migration.prototype.up = function() {
    		this.models.createModel('A', {
    			id: [this.UUID],
    			name: [this.String],
    			b: [this.BelongsTo(this.models.B)]
    		});

			this.models.createModel('B', {
    			id: [this.UUID],
    			name: [this.String],
    			a: [this.HasOne(this.models.A)]
    		});
    	};
    	Migration.prototype.down = function() {
    		this.models.destroyModel('A');
    		this.models.destroyModel('B');
    	};

    	migrations.addMigration(Migration, 1);
    	migrations.migrate(0, 1)
    		.then(function() {
    			done();
    		})
    		.catch(function(error) {
    			done(error);
    		});
    });

	it('can query 1:1 association', function(done) {
    	function Migration() {}
    	Migration.prototype.up = function() {
			this.models.createModel('B', {
    			id: [this.UUID],
    			name: [this.String],
    			a: [this.HasOne(this.models.A)]
    		});

    		this.models.createModel('A', {
    			id: [this.UUID],
    			name: [this.String],
    			b: [this.BelongsTo(this.models.B), this.AutoFetch, this.Optional]
    		});
    	};
    	Migration.prototype.down = function() {
    		this.models.destroyModel('A');
    		this.models.destroyModel('B');
    	};

    	migrations.addMigration(Migration, 1);
    	migrations.migrate(0, 1)
    		.then(function() {
    			return models.B.create({
    				name: 'Bert'
    			});
    		})
    		.then(function(b) {
    			assert.notEqual(b, null);
    			return models.A.create({
    				name: 'Aart',
    				b: b
    			});
    		})
    		.then(function(a) {
    			assert.notEqual(a, null);
    			return models.A.findOne({});
    		})
    		.then(function(a) {
    			assert.notEqual(a, null);
    			assert.equal(a.name, 'Aart');
    			assert.notEqual(a.b, null);
    			assert.equal(a.b.name, 'Bert');

    			// Even though .b exists--an accessor method should also be available
    			return a.getB();
    		})
    		.then(function(b) {
    			assert.notEqual(b, null);
    			assert.equal(b.name, 'Bert');

    			return done();
    		})
    		.catch(function(error) {
    			done(error);
    		})
    		.done();
    });

	it('can create 1:1 auto fetched association', function(done) {
    	function Migration() {}
    	Migration.prototype.up = function() {
			this.models.createModel('B', {
    			id: [this.UUID],
    			name: [this.String],
    			a: [this.HasOne(this.models.A)]
    		});

    		this.models.createModel('A', {
    			id: [this.UUID],
    			name: [this.String],
    			b: [this.BelongsTo(this.models.B), this.AutoFetch, this.Optional]
    		});
    	};
    	Migration.prototype.down = function() {
    		this.models.destroyModel('A');
    		this.models.destroyModel('B');
    	};

    	migrations.addMigration(Migration, 1);
    	migrations.migrate(0, 1)
    		.then(function() {
    			return models.B.create({
    				name: 'Bert'
    			});
    		})
    		.then(function(b) {
    			assert.notEqual(b, null);
    			return models.A.create({
    				name: 'Aart',
    				b: b
    			});
    		})
    		.then(function(a) {
    			assert.notEqual(a, null);
    			return models.A.findOne({});
    		})
    		.then(function(a) {
    			assert.notEqual(a, null);
    			assert.equal(a.name, 'Aart');
    			assert.notEqual(a.b, null);
    			assert.equal(a.b.name, 'Bert');

    			return models.B.findOne({});
    		})
    		.then(function(b) {
    			assert.notEqual(b, null);
    			assert.equal(b.name, 'Bert');

    			// We did not specify an auto-fetch--so this should be available
    			assert.equal(b.a, null);

    			return b.getA();
    		})
    		.then(function(a) {
    			assert.notEqual(a, null);
    			assert.equal(a.name, 'Aart');
    			return done();
    		})
    		.catch(function(error) {
    			done(error);
    		})
    		.done();
    });
});
