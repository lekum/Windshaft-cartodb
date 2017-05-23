require('../support/test_helper');

var serverOptions = require('../../lib/cartodb/server_options');
serverOptions.analysis.batch.inlineExecution = true;

var assert = require('assert');
var RedisPool = require('redis-mpool');
var cartodbRedis = require('cartodb-redis');
var PgConnection = require('../../lib/cartodb/backends/pg_connection');
var AnalysisBackend = require('../../lib/cartodb/backends/analysis');

var redisPool = new RedisPool(global.environment.redis);
var metadataBackend = cartodbRedis({pool: redisPool});
var pgConnection = new PgConnection(metadataBackend);
var analysisBackend = new AnalysisBackend(metadataBackend, serverOptions.analysis);

var MapConfigAdapter = require('../../lib/cartodb/models/mapconfig/map-config-adapter');
var adapter = require('../../lib/cartodb/models/mapconfig/adapter');

var mapConfigAdapter = new MapConfigAdapter(
    new adapter.Datasources(),
    new adapter.Analysis(analysisBackend),
    new adapter.TTQuery()
);

describe('tt-query-map-config-adapter', function() {

    var USER = 'localhost';

    before(function(done) {
        var self = this;
        var config = {};

        pgConnection.setDBConn(USER, config, function(err) {
            assert.ok(!err);

            pgConnection.setDBAuth(USER, config, function(err) {
                assert.ok(!err);

                self.analysisConfiguration = {
                    user: USER,
                    db: {
                        host: config.dbhost,
                        port: config.dbport,
                        dbname: config.dbname,
                        user: config.dbuser,
                        pass: config.dbpassword
                    },
                    batch: {
                        username: USER,
                        apiKey: config.api_key
                    }
                };

                done();
            });
        });
    });

    it('should modify layers with TT queries', function(done) {
        var _mapConfig = {
            layers: [
                {
                    type: 'mapnik',
                    options: {
                        cartocss: '#l { marker-width: 2; marker-allow-overlap: true; marker-line-width: 0; }',
                        cartocss_version: '2.3.0',
                        source: {
                            id: 'a0'
                        }
                    }
                }
            ],
            dataviews: {
                rank_max_histogram: {
                    type: 'histogram',
                    source: {
                        id: 'a0'
                    },
                    options: {
                        column: 'rank_max',
                        bins: 10
                    }
                },
                adm0_a3_count: {
                    type: 'aggregation',
                    source: {
                        id: 'a0'
                    },
                    options: {
                        column: 'adm0_a3',
                        aggregation: 'count',
                        aggregationColumn: 'adm0_a3'
                    }
                }
            },
            analyses: [
                {
                    id: 'a0',
                    type: 'source',
                    params: {
                        query: 'SELECT * FROM populated_places_simple_reduced'
                    }
                }
            ]
        };

        var filters = {
            dataviews: {
                rank_max_histogram: {
                    'min': 8,
                    'max': 12
                },
                adm0_a3_count: {
                    accept: ['USA', 'IND']
                }
            }
        };

        var params = {
            filters: JSON.stringify(filters)
        };
        var context = {
            analysisConfiguration: this.analysisConfiguration
        };

        var TTName = 'TT_populated_places_simple_reduced';
        var getTTNameFn = adapter.TTQuery.prototype.getTTName;
        adapter.TTQuery.prototype.getTTName = function(query, callback) {
            return callback(null, TTName);
        };

        mapConfigAdapter.getMapConfig(USER, _mapConfig, params, context, function(err, mapConfig) {
            adapter.TTQuery.prototype.getTTName = getTTNameFn;

            assert.ok(!err, err);
            assert.ok(Array.isArray(mapConfig.layers));
            assert.equal(mapConfig.layers.length, 1);

            var tt = mapConfig.layers[0].options.tt;

            assert.equal(tt.table, TTName);

            assert.ok(Array.isArray(tt.filters));
            assert.equal(tt.filters.length, 2);
            assert.deepEqual(tt.filters[0], {
                type: 'range',
                column: 'rank_max',
                min: 8,
                max: 12
            });
            assert.deepEqual(tt.filters[1], {
                type: 'category',
                column: 'adm0_a3',
                accept: ['USA', 'IND']
            });

            assert.ok(Array.isArray(tt.aggregations));
            // let's assume only aggregation dataviews get here
            assert.equal(tt.aggregations.length, 1);
            assert.deepEqual(tt.aggregations[0], {
                aggregate_function: 'count',
                aggregate_column: 'cartodb_id',
                type: 'numeric'
            });

            assert.equal(mapConfig.layers[0].options.sql, [
                'SELECT * FROM TT_TileData(',
                '  \'TT_populated_places_simple_reduced\',',
                '  \'@bbox\'::json,',
                '  ARRAY[\'{"min":8,"max":12,"type":"range","column":"rank_max"}\',' +
                '\'{"accept":["USA","IND"],"type":"category","column":"adm0_a3"}\']::json[],',
                '  ARRAY[\'{"aggregate_function":"count","aggregate_column":"cartodb_id","type":"numeric"}\']::json[],',
                '  @zoom',
                ') AS tiledata (',
                '  cartodb_id int,',
                '  the_geom_webmercator geometry,',
                '  count_vals numeric',
                ')'
            ].join('\n'));

            done();
        });
    });
});