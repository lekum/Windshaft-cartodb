var assert = require('assert');
var _ = require('underscore');
var test_helper = require('../../support/test_helper');

suite('req2params', function() {

    // configure redis pool instance to use in tests
    var CartodbWindshaft = require('../../../lib/cartodb/server');
    var serverOptions = require('../../../lib/cartodb/server_options');
    var server = new CartodbWindshaft(serverOptions);

    var test_user = _.template(global.environment.postgres_auth_user, {user_id:1});
    var test_pubuser = global.environment.postgres.user;
    var test_database = test_user + '_db';

    
    test('can be found in server_options', function(){
      assert.ok(_.isFunction(server.req2params));
    });

    function prepareRequest(req) {
        req.profiler = {
            done: function() {}
        };
        req.context = { user: 'localhost' };
        return req;
    }

    test('cleans up request', function(done){
      var req = {headers: { host:'localhost' }, query: {dbuser:'hacker',dbname:'secret'}};
      server.req2params(prepareRequest(req), function(err, req) {
          if ( err ) { done(err); return; }
          assert.ok(_.isObject(req.query), 'request has query');
          assert.ok(!req.query.hasOwnProperty('dbuser'), 'dbuser was removed from query');
          assert.ok(req.hasOwnProperty('params'), 'request has params');
          assert.ok(!req.params.hasOwnProperty('interactivity'), 'request params do not have interactivity');
          assert.equal(req.params.dbname, test_database, 'could forge dbname: '+ req.params.dbname);
          assert.ok(req.params.dbuser === test_pubuser, 'could inject dbuser ('+req.params.dbuser+')');
          done();
      });
    });

    test('sets dbname from redis metadata', function(done){
      var req = {headers: { host:'localhost' }, query: {} };
      server.req2params(prepareRequest(req), function(err, req) {
          if ( err ) { done(err); return; }
          //console.dir(req);
          assert.ok(_.isObject(req.query), 'request has query');
          assert.ok(!req.query.hasOwnProperty('dbuser'), 'dbuser was removed from query');
          assert.ok(req.hasOwnProperty('params'), 'request has params');
          assert.ok(!req.params.hasOwnProperty('interactivity'), 'request params do not have interactivity');
          assert.equal(req.params.dbname, test_database);
          assert.ok(req.params.dbuser === test_pubuser, 'could inject dbuser ('+req.params.dbuser+')');
          done();
      });
    });

    test('sets also dbuser for authenticated requests', function(done){
      var req = {headers: { host:'localhost' }, query: {map_key: '1234'} };
      server.req2params(prepareRequest(req), function(err, req) {
          if ( err ) { done(err); return; }
          //console.dir(req);
          assert.ok(_.isObject(req.query), 'request has query');
          assert.ok(!req.query.hasOwnProperty('dbuser'), 'dbuser was removed from query');
          assert.ok(req.hasOwnProperty('params'), 'request has params');
          assert.ok(!req.params.hasOwnProperty('interactivity'), 'request params do not have interactivity');
          assert.equal(req.params.dbname, test_database);
          assert.equal(req.params.dbuser, test_user);

          req = {
              headers: {
                  host:'localhost'
              },
              query: {
                  map_key: '1235'
              }
          };
          server.req2params(prepareRequest(req), function(err, req) {
              // wrong key resets params to no user
              assert.ok(req.params.dbuser === test_pubuser, 'could inject dbuser ('+req.params.dbuser+')');
              done();
          });
      });
    });

    test('it should extend params with decoded lzma', function(done) {
        var qo = {
            config: {
                version: '1.3.0'
            }
        };
        test_helper.lzma_compress_to_base64(JSON.stringify(qo), 1, function(err, data) {
            var req = {
                headers: {
                    host:'localhost'
                },
                query: {
                    non_included: 'toberemoved',
                    api_key: 'test',
                    style: 'override',
                    lzma: data
                }
            };
            server.req2params(prepareRequest(req), function(err, req) {
                if ( err ) {
                    return done(err);
                }
                var query = req.params;
                assert.deepEqual(qo.config, query.config);
                assert.equal('test', query.api_key);
                assert.equal(undefined, query.non_included);
                done();
            });
        });
    });

});
