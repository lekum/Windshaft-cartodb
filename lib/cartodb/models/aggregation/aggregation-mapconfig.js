'use strict';

const MapConfig = require('windshaft').model.MapConfig;
const aggregationQuery = require('./aggregation-query');
const aggregationValidator = require('./aggregation-validator');
const {
    createPositiveNumberValidator,
    createIncludesValueValidator,
    createAggregationColumnsValidator,
    createAggregationFiltersValidator
} = aggregationValidator;

const queryUtils = require('../../utils/query-utils');

const removeDuplicates = arr => [...new Set(arr)];

module.exports = class AggregationMapConfig extends MapConfig {
    static get AGGREGATIONS () {
        return aggregationQuery.SUPPORTED_AGGREGATE_FUNCTIONS;
    }

    static get PLACEMENTS () {
        return aggregationQuery.SUPPORTED_PLACEMENTS;
    }

    static get THRESHOLD () {
        return 1e5; // 100K
    }

    static get RESOLUTION () {
        return 1;
    }

    static get SUPPORTED_GEOMETRY_TYPES () {
        return [
            'ST_Point'
        ];
    }

    static get FILTER_PARAMETERS () {
        return [
            // TODO: valid combinations of parameters:
            // * Except for less/greater params, only one parameter allowed per filter.
            // * Any less parameter can be combined with one of the greater paramters. (to define a range)
            'less_than', 'less_than_or_equal_to',
            'greater_than', 'greater_than_or_equal_to',
            'equal', 'not_equal',
            'between', 'in', 'not_in'
        ];
    }

    static supportsGeometryType(geometryType) {
        return AggregationMapConfig.SUPPORTED_GEOMETRY_TYPES.includes(geometryType);
    }

    static  getAggregationGeometryColumn() {
        return aggregationQuery.GEOMETRY_COLUMN;
    }

    constructor (user, config, connection, datasource) {
        super(config, datasource);

        const validate = aggregationValidator(this);
        const positiveNumberValidator = createPositiveNumberValidator(this);
        const includesValidPlacementsValidator = createIncludesValueValidator(this, AggregationMapConfig.PLACEMENTS);
        const aggregationColumnsValidator = createAggregationColumnsValidator(this, AggregationMapConfig.AGGREGATIONS);
        const aggregationFiltersValidator = createAggregationFiltersValidator(
            this, AggregationMapConfig.FILTER_PARAMETERS
        );

        validate('resolution', positiveNumberValidator);
        validate('placement', includesValidPlacementsValidator);
        validate('threshold', positiveNumberValidator);
        validate('columns', aggregationColumnsValidator);
        validate('filters', aggregationFiltersValidator);

        this.user = user;
        this.pgConnection = connection;
    }

    getAggregatedQuery (index) {
        const { sql_raw, sql } = this.getLayer(index).options;
        const {
            // The default aggregation has no placement, columns or dimensions;
            // this enables the special "full-sample" aggregation.
            resolution = AggregationMapConfig.RESOLUTION,
            threshold = AggregationMapConfig.THRESHOLD,
            placement,
            columns = {},
            dimensions = {},
            filters = {}
        } = this.getAggregation(index);

        return aggregationQuery({
            query: sql_raw || sql,
            resolution,
            threshold,
            placement,
            columns,
            dimensions,
            filters,
            isDefaultAggregation: this._isDefaultLayerAggregation(index)
        });
    }

    isAggregationMapConfig () {
        return this.isVectorOnlyMapConfig() || this.hasAnyLayerAggregation();
    }

    isAggregationLayer (index) {
        return this.isVectorOnlyMapConfig() || this.hasLayerAggregation(index);
    }

    hasAnyLayerAggregation () {
        const layers = this.getLayers();

        for (let index = 0; index < layers.length; index++) {
            if (this.hasLayerAggregation(index)) {
                return true;
            }
        }

        return false;
    }

    hasLayerAggregation (index) {
        const layer = this.getLayer(index);
        const { aggregation } = layer.options;

        return aggregation !== undefined && (typeof aggregation === 'object' || typeof aggregation === 'boolean');
    }

    getAggregation (index) {
        if (this.isVectorOnlyMapConfig() && !this.hasLayerAggregation(index)) {
            return {};
        }

        const { aggregation } = this.getLayer(index).options;

        if (typeof aggregation === 'boolean') {
            return {};
        }

        return aggregation;
    }

    getLayerAggregationColumns (index, callback) {
        if (this._isDefaultLayerAggregation(index)) {
            const skipGeoms = true;
            return this.getLayerColumns(index, skipGeoms, (err, columns) => {
                if (err) {
                    return callback(err);
                }

                return callback(null, columns);
            });
        }

        const columns = this._getLayerAggregationRequiredColumns(index);

        return callback(null, columns);
    }

    _getLayerAggregationRequiredColumns (index) {
        const { columns, dimensions } = this.getAggregation(index);

        let finalColumns = ['cartodb_id', '_cdb_feature_count'];

        let aggregatedColumns = [];
        if (columns) {
            aggregatedColumns = Object.keys(columns);
        }

        let dimensionsColumns = [];
        if (dimensions) {
            dimensionsColumns = Object.keys(dimensions);
        }

        return removeDuplicates(finalColumns.concat(aggregatedColumns).concat(dimensionsColumns));
    }

    doesLayerReachThreshold(index, featureCount) {
        const threshold = this.getAggregation(index) && this.getAggregation(index).threshold ?
            this.getAggregation(index).threshold :
            AggregationMapConfig.THRESHOLD;

        return featureCount >= threshold;
    }

    getLayerColumns (index, skipGeoms, callback) {
        const geomColumns = ['the_geom', 'the_geom_webmercator'];
        const limitedQuery = ctx => `SELECT * FROM (${ctx.query}) __cdb_schema LIMIT 0`;
        const layer = this.getLayer(index);

        this.pgConnection.getConnection(this.user, (err, connection) => {
            if (err) {
                return callback(err);
            }

            const sql = limitedQuery({
                query: queryUtils.substituteDummyTokens(layer.options.sql)
            });

            connection.query(sql, (err, result) => {
                if (err) {
                    return callback(err);
                }

                let columns = result.fields || [];

                columns = columns.map(({ name }) => name);

                if (skipGeoms) {
                    columns = columns.filter((column) => !geomColumns.includes(column));
                }

                return callback(err, columns);
            });
        });
    }

    _isDefaultLayerAggregation (index) {
        const aggregation = this.getAggregation(index);

        return (this.isVectorOnlyMapConfig() && !this.hasLayerAggregation(index)) ||
            aggregation === true ||
            this._isDefaultAggregation(aggregation);
    }

    _isDefaultAggregation (aggregation) {
        return aggregation.placement === undefined &&
            aggregation.columns === undefined &&
            this._isEmptyParameter(aggregation.dimensions) &&
            this._isEmptyParameter(aggregation.filters);
    }

    _isEmptyParameter(parameter) {
        return parameter === undefined || parameter === null || this._isEmptyObject(parameter);
    }

    _isEmptyObject (parameter) {
        return typeof parameter === 'object' && Object.keys(parameter).length === 0;
    }
};
