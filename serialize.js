"use strict";

var Serializer = require('jsonapi-serializer');
var url = require('url');
var path = require('path');
var inflection = require('inflection');

function serialize(name, data, options) {
  //Workaround as Serializer blows up if data is null.
  //TODO: submit issue to serializer library to get this
  //cleaned up
  var dataIsNull = !data;

  //yuck. null === 'object' so need to also check for not null
  //also need to exclude arrays
  if (!Array.isArray(data) && !!data && typeof data === 'object') {
    if (Object.keys(data).length === 0) {
      dataIsNull = true;
    }
  }

  if (dataIsNull) {
    data = []
  }
  var result = new Serializer(name, data, options);
  if (dataIsNull) {
    result.data = null;
  }
  return result;
}

function pluralForModel(model) {
  if (model.settings && model.settings.http && model.settings.http.path) {
    return model.settings.http.path;
  }

  if (model.settings && model.settings.plural) {
    return model.settings.plural
  }

  if (model.definition && model.definition.settings && model.definition.settings.plural) {
    return model.definition.settings.plural
  }

  return inflection.pluralize(model.sharedClass.name);
}

function modelNameForPlural(models, plural) {
  return Object.keys(models).filter(function (name) {
    if (models[name] && models[name].definition) {
      return models[name].definition.settings.plural === plural
    }
    return false
  })[0]
}

function modelForPlural(models, plural) {
  return models[modelNameForPlural(models, plural)]
}

function attributesForModel(model) {
  return Object.keys(model.definition.properties)
}

function attributesWithoutIdForModel(model) {
  var attrs = attributesForModel(model)
  //TODO: the id primary key should not be hard coded.
  //its possible the PK may be something else.
  attrs.splice(attrs.indexOf('id'), 1)
  return attrs
}

function clone(object) {
  return JSON.parse(JSON.stringify(object))
}

function filterFromContext(context) {
  try {
    return JSON.parse(context.args.filter)
  } catch (e) {
    return false
  }
}

function modelNameFromContext(context) {
  return context.method.sharedClass.name
}

function urlFromContext(context) {
  return context.req.protocol + '://' + context.req.get('host') + context.req.originalUrl
}

function primaryKeyFromModel(model) {
  console.log(model.definition.properties)
}

function buildModelUrl(protocol, host, apiRoot, modelName, id) {
  var result;
  try {
    result = url.format({
      protocol: protocol,
      host: host,
      pathname: url.resolve('/', [apiRoot, modelName, id].join('/'))
    })
  } catch (e) {
    return '';
  }
  return result;
}

module.exports = function (app, options) {
  var remotes = app.remotes();

  remotes.after('**', function (ctx, next) {
    ctx.res.set({'Content-Type': 'application/vnd.api+json'});
    //housekeeping, just skip verbs we definitely aren't
    //interested in handling.
    if (ctx.req.method === 'DELETE') return next();
    if (ctx.req.method === 'PUT') return next();
    if (ctx.req.method === 'HEAD') return next();

    var data = clone(ctx.result)

    var modelName = modelNameFromContext(ctx)

    //HACK: specifically when data is null and GET :model/:id
    //is being accessed, we should not treat null as ok. It needs
    //to be 404'd and to do that we just exit out of this
    //after remote hook and let the middleware chain continue
    if (data === null && ctx.method.name === 'findById') {
      return next();
    }

    var attrs = attributesWithoutIdForModel(app.models[modelName])

    var type = modelName;
    //match on __GET__, etc.
    if (ctx.methodString.match(/.*\.__.*__.*/)) {
      //get the model name of the related model in plural form.
      //we cant just get the relationship name because the name of
      //the relationship may not match the related model plural.
      //eg. /posts/1/author could actually be a user model so we
      //would want type = 'users'

      //WARNING: feels fragile but functional.
      var relatedModelName = ctx.method.returns[0].type;
      var relatedModelPlural = pluralForModel(app.models[relatedModelName])
      if (relatedModelPlural) {
        type = relatedModelPlural
      }

      //if the model in question is a related model, we need to
      //overwrite the attrs variable with attrs from the related
      //model.
      attrs = attributesWithoutIdForModel(app.models[relatedModelName])
    }

    var serializeOptions = {
      id: 'id',
      attributes: attrs,
      topLevelLinks: { self: urlFromContext(ctx) },
      dataLinks: {
        self: function (item) {
          if (relatedModelPlural) {
            //TODO: fix url building. Use url module.
            //currently doesnt take into account if /api/ is in the url etc.
            return buildModelUrl(ctx.req.protocol, ctx.req.get('host'), options.restApiRoot, relatedModelPlural, item.id);
          }
          return buildModelUrl(ctx.req.protocol, ctx.req.get('host'), options.restApiRoot, pluralForModel(app.models[modelName]), item.id);
        }
      }
    }

    //append `related` links key if applicable
    //creates /:model/:id/:model from /:model/:id/relationships/:model
    if (serializeOptions.topLevelLinks.self.match(/\/relationships\//)) {
      serializeOptions.topLevelLinks.related = serializeOptions.topLevelLinks.self.replace('/relationships/', '/');
    }

    //serialize the data into json api format.
    ctx.result = serialize(type, data, serializeOptions);

    //once again detect that we are dealing with a relationships
    //url. this time post serialization.
    //Clean up data here by deleting resource level attributes
    //and links. Handle collection and single resource.
    //TODO: create an isRelationshipRequest helper
    if (serializeOptions.topLevelLinks.self.match(/\/relationships\//)) {
      if (ctx.result.data) {
        if (Array.isArray(ctx.result.data)) {
          ctx.result.data = ctx.result.data.map(function (item) {
            delete item.attributes;
            delete item.links;
            return item;
          });
        } else {
          delete ctx.result.data.attributes;
          delete ctx.result.data.links;
        }
      }
    }
    next();
  });
}
