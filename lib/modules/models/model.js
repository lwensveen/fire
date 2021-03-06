exports = module.exports = Model;

var utils = require('./../../helpers/utils');
var ModelInstance = require('./model-instance');
var Property = require('./property');
var AccessControl = require('./access-control');
var Q = require('q');
var inflection = require('inflection');

function unauthenticatedError(authenticator) {
	var error = new Error();

	if(authenticator) {
		error.status = 403;
		error.message = 'Forbidden';
	}
	else {
		error.status = 401;
		error.message = 'Unauthorized';
	}

	return error;
}

/**
 * Do not construct a `Model` instance yourself, instead, you can construct a model via {@link App#model}.
 *
 * The model is a collection of properties and associations. Through a model you can find, update, create and delete (CRUD) model instances.
 *
 * @constructor
 */
function Model(name, models, moduleProperties, activeMigration) {
	this._name = name;
	this.models = models;
	this.options = {};
	this._properties = null;
	this._methods = {};
	this._table = null;
	this._accessControl = null;
	this._associations = {};

	this._activeMigration = activeMigration;

	if(moduleProperties) {
		moduleProperties.set(this);
		this._moduleProperties = moduleProperties;
	}
}

/**
 * Returns if this model is shared.
 *
 * A shared model is available in every app. A shared model's migrations are created in the master app.
 */
Model.prototype.isShared = function() {
	return (this.models.sharedModelNames.indexOf(this._name) >= 0);
};

/**
 * Authorizes the current authenticator, for example, your user model. To declare an authenticator have a look at {@link PropertyTypes#Authenticate}.
 *
 * For example, consider the following authenticator model:
 * ```
 * function User() {
 * 	this.email = [this.String, this.Authenticate];
 * 	this.fullName = [this.String];
 * }
 * app.model(User);
 * ```
 *
 * In your controller, you can sign in the user via the following:
 * ```
 * function SignInController($scope, UserModel) {
 * 	$scope.signIn = function(email, password) {
 * 		return UserModel.authorize({email: email, password: password})
 * 			.then(function(user) {
 * 				// The user signed in. TODO: redirect the user to the signed-in area: $location.path('/dashboard')
 * 			})
 * 			.catch(function(error) {
 * 				// TODO: Show the user some error.
 * 			});
 * 	};
 * }
 * app.controller(SignInController);
 * ```
 *
 * To sign out a user you can use {@link Model#signOut}. To return the currently signed in user, have a look at {@link Model#getMe}.
 *
 * @name Model#authorize
 * @param {Dictionary} authenticateMap Dictionary containing the authenticating property and the password.
 * @function
 */
Model.prototype.authorize = function(authenticateMap) {
	if(!this.isPasswordBasedAuthenticator()) {
		throw new Error('Model#authorize is only available on a password-based authenticator model.');
	}

	var whereMap = {};
	whereMap[this.options.authenticatingProperty.name] = authenticateMap[this.options.authenticatingProperty.name];

	return this.getOne(whereMap).then(function(modelInstance) {
		return modelInstance.validateHash('password', authenticateMap.password)
			.then(function(valid) {
				if(valid) {
					// TODO: remove reset password model related to the modelInstance
					return modelInstance;
				}
				else {
					throw new Error('Incorrect password provided.');
				}
			});
	});
};

/**
 * Creates an empty model instance. This model instance is not persisted to the datastore until calling ModelInstance#save.
 */
Model.prototype.new = function() {
	return new ModelInstance(this, null, null, null, null, true, false, {});
};

/**
 * Signs out the current authenticator. To sign in a user, see {@link Model#authorize}.
 *
 * For example, the below signs out a currently signed in user:
 * ```
 * function AccountController($scope, UserModel, $location) {
 * 	$scope.signOut = function() {
 * 		return UserModel.signOut()
 * 			.then(function() {
 * 				$location.path('/');
 * 			});
 * 	};
 * }
 * app.controller(AccountController);
 * ```
 *
 * This method is only available on the authenticator model.
 */
Model.prototype.signOut = function() {
	// TODO: Implement this in a model instance instead.

	throw new Error('Not Implemented');
};

/**
 * Returns the currently authenticated model instance, or null if not authenticated. Only returns a model instance if {@link Model#authorize} is previously called, otherwise this method returns null.
 *
 * For example, on the client-side:
 * ```
 * function UserController(UserModel) {
 * 	UserModel.getMe()
 * 		.then(funcion(user) {
 * 			//
 * 		});
 * }
 * app.controller(UserModel);
 * ```
 *
 * On the back-end side:
 * ```
 * app.get('/users/me', function(UserModel, request) {
 * 	return UserModel.getMe(request);
 * });
 * ```
 *
 * Only available on an authenticator model. To define an authenticator model, have a look at {@link PropertyTypes#Authenticate}.
 *
 * @param {express.request} request Required in the back-end. The current request.
 */
Model.prototype.findMe = function(request) {
	if(!request) {
		throw new Error('`' + this._name + '#findMe` requires a request argument on the back-end.');
	}

	var authenticatorModel = this.models.getAuthenticator();
	if(!authenticatorModel) {
		return Q.when(null);
	}

	if(authenticatorModel != this) {
		throw new Error('Warning: `' + this._name + '#findMe` is not available because it\'s not the authenticator.');
	}

	var credentials = utils.parseAuthorization(request.headers.authorization);
	if(credentials) {
		var findMap = {};
		findMap[this.options.authenticatingProperty.name] = credentials[0];
		findMap.accessToken = credentials[1];
		return authenticatorModel.findOne(findMap);
	}

	if(!request.session.at) {
		return Q.when(null);
	}

	// TODO: Should we use the login tokens here as well?

	return this.findOne({accessToken:request.session.at});
};

/**
 * Returns the currently authenticated model instance or throws an error. See {@link Model#findMe} as well.
 *
 * @param {express.HTTPRequest} request
 */
Model.prototype.getMe = function(request) {
	return this.findMe(request)
		.then(function(modelInstance) {
			if(modelInstance) {
				return modelInstance;
			}
			else {
				var error = new Error('Unauthorized');
				error.status = 401;
				throw error;
			}
		});
};

/**
 * Resets the authenticator's password if forgot password was requested.
 *
 * If the reset password succeeds, the onResetPassword method on your authenticator is called.
 *
 * @param {String} resetToken      The token generated from the forgotPassword method.
 * @param {String} newPassword     The new password.
 * @param {String} confirmPassword The new password again.
 */
Model.prototype.resetPassword = function(resetToken, newPassword, confirmPassword) {
	if(!this.isPasswordBasedAuthenticator()) {
		throw new Error('Model#resetPassword is only available on a password-based authenticator model.');
	}

	if(newPassword != confirmPassword) {
		throw new Error('The passwords provided do not match.');
	}

	var self = this;
	return self.models[self.getName() + 'ResetPassword'].getOne({token: resetToken})
		.then(function(resetPassword) {
			return Q.all([
				self.updateOne({id: resetPassword.authenticator}, {password: newPassword}),
				self.models[self.getName() + 'ResetPassword'].remove({id: resetPassword.id})
			]);
		})
		.spread(function(authenticator) {
			if(authenticator && self.onResetPassword) {
				var privateMap = {};
				privateMap.authenticator = authenticator;
				privateMap[utils.lcfirst(self._name)] = authenticator;
				return Q.when(self.models.app.injector.call(self.onResetPassword, privateMap, authenticator))
					.then(function() {
						return authenticator;
					});
			}
			else {
				return authenticator;
			}
		});
};

/**
 * Starts the forgot password process. If a correct `authenticatingPropertyValue` is provided, for example a valid email of your user, create a reset password token.
 *
 * When the forgot password succeeds, `onForgotPassword` is called on your authenticator. In here, you could, for example, send a reset password email.
 *
 * @param {String} authenticatingPropertyValue The value of your authenticating property e.g. email.
 */
Model.prototype.forgotPassword = function(authenticatingPropertyValue) {
	if(!this.isPasswordBasedAuthenticator()) {
		throw new Error('Model#forgotPassword is only available on a password-based authenticator model.');
	}

	var self = this;

	var findMap = {};
	findMap[self.options.authenticatingProperty.name] = authenticatingPropertyValue;

	return self.findOne(findMap)
		.then(function(authenticator) {
			if(authenticator) {
				return self.models[self.getName() + 'ResetPassword'].findOrCreate({authenticator: authenticator})
					.then(function(resetPassword) {
						if(self.onForgotPassword) {
							var privateMap = {};
							privateMap.authenticator = authenticator;
							privateMap[utils.lcfirst(self._name)] = authenticator;
							privateMap.resetPassword = resetPassword;

							return self.models.app.injector.call(self.onForgotPassword, privateMap, authenticator);
						}
					});
			}
		})
		.then(function() {
			return {};
		});
};

/**
 * Dasherizes the model's name as the naming convention of the file name (without the extension).
 *
 * @returns {String}
 * @access private
 */
Model.prototype.getFileName = function() {
	return inflection.transform(this._name, ['tableize', 'dasherize', 'singularize']);
};

/**
 * Returns true if this model is the authenticator. The authenticator is, for example, the User model. This is defined by setting the {@link PropertyTypes#Authenticate} property type.
 *
 * If you need to get the authenticator model, use {@link Models#getAuthenticator}.
 *
 * @returns {Boolean}
 *
 * @access private
 */
Model.prototype.isAuthenticator = function() {
	return (!!this.options.authenticatingProperty);
};

/**
 * Returns if this model is the authenticator with a password property.
 */
Model.prototype.isPasswordBasedAuthenticator = function() {
	return (!!this.options.authenticatingProperty && !!this.options.isPasswordBased);
};

/**
 * Sets the active migration. When an active migration is set, all calls are proxied to the migration instead.
 *
 * @param {Migration} migration The currently running migration.
 *
 * @access private
 */
Model.prototype.setActiveMigration = function(migration) {
	this._activeMigration = migration;
};

/**
 * Returns all the property names-property pairs which are part of an association.
 *
 * @returns {Dictionary}
 * @access private
 */
Model.prototype.getAllAssociations = function() {
	return this.getAssociations();
};

/**
 * Synonym of {@link Model#getAllAssociations}.
 * @access private
 */
Model.prototype.getAssociations = function() {
	return this._associations;
};

/**
 * Returns a property which is an association.
 *
 * @param {String} associationName The name of the property
 * @returns {Property}
 * @access private
 */
Model.prototype.getAssociation = function(associationName) {
	return this._associations[associationName];
};

/**
 * Removes all properties which are part of an association.
 *
 * This method is invoked when a model gets destroyed during a migration.
 *
 * @access private
 */
Model.prototype.removeAllAssociations = function() {
	var self = this;
	Object.keys(this._associations).forEach(function(associationName) {
		self.removeProperty(self._associations[associationName]);
	});
};

/**
 * Returns all properties which are associations to @model. Optionally only the association properties which name matches linkedPropertyName.
 *
 * @access private
 *
 * @param {Model} model              The model.
 * @param {String=} linkedPropertyName [description]
 * @returns {Property[]}
 */
Model.prototype.findAssociationsTo = function(model, linkedPropertyName) {
	var associations = [];

	var self = this;
	Object.keys(this._associations).forEach(function(name) {
		var association = self._associations[name];

		if(association.getAssociatedModel() == model || association.options.referenceName == model.getName()) {
			if(!linkedPropertyName || linkedPropertyName == name) {
				associations.push(association);
			}
		}
	});

	return associations;
};

/**
 * Sets the table of the model.
 *
 * @access private
 *
 * @param {Table} table
 */
Model.prototype.setTable = function(table) {
	this._table = table;
};

/**
 * Returns the table.
 *
 * @throws {Error} If table is not set.
 * @returns {Table}
 *
 * @access private
 */
Model.prototype.getTable = function() {
	if(!this._table) {
		throw new Error('No table exists for model `' + this.getName() + '`.');
	}

	return this._table;
};

/**
 * Returns the name of the model.
 *
 * @returns {String}
 * @access private
 */
Model.prototype.getName = function() {
	return this._name;
};

/**
 * Adds a property to the model.
 *
 * If a migration is running, passes the property to the migration.
 *
 * If the property is an association, stores the association internally.
 *
 * @access private
 *
 * @param {Property}  property The property to add.
 * @param {Boolean} isNew    True if the property is newly added to the model, otherwise false.
 * @returns {Property}
 */
Model.prototype.addProperty = function(property, isNew) {
	if(!property.name || property.name[0] == '_' || property.name[0] == '$') {
		throw new Error('Invalid property name `' + property.name + '`. Property names may not start with _ or $ as they are reserved.');
	}

	if(!isNew && this._activeMigration) {
		this._activeMigration.addProperty(property, this._properties[property.name]);
	}

	this._properties[property.name] = property;

	if(property.isAssociation()) {
		this._associations[property.name] = property;
	}

	return property;
};

/**
 * Creates a new property and returns it.
 *
 * If no property types are supplied this method returns null.
 *
 * @access private
 *
 * @param {String}  propertyName  The name of the new property.
 * @param {PropertyType[]}  propertyTypes The property types of the new property.
 * @param {Boolean} isNew         True if the property is newly added to the model, otherwise false.
 * @returns {Property}
 */
Model.prototype._addProperty = function(propertyName, propertyTypes, isNew) {
	if(propertyTypes && propertyTypes.length > 0) {
		return this.addProperty(new Property(propertyName, propertyTypes, this, this.models), isNew);
	}
	return null;
};

/**
 * Adds an isomorphic method to the model. This creates both instance methods and class methods to the model and the methods are available in both the back-end and front-end.
 *
 * To create a method:
 * ```
 * function User() {
 * 	this.name = [this.String, this.Required];
 * 	this.getUpperCaseName = function() {
 * 		return this.name.toUpperCase();
 * 	};
 * }
 * app.model(User);
 * ```
 *
 * To call a method:
 * ```
 * app.service(function TestService(UserModel) {
 * 	UserModel.findOne({}).then(function(user) {
 * 		var upperCaseName = user.getUpperCaseName();
 * 		console.log(upperCaseName);
 * 	});
 * });
 * ```
 *
 * @access private
 *
 * @param {String} methodName The name of the method.
 * @param {Function} method     The function.
 */
Model.prototype._addMethod = function(methodName, method) {
	this._methods[methodName] = method;
};

/**
 * Removes the property part of a many association to model.
 *
 * @access private
 *
 * @param {Model} model
 */
Model.prototype._removeManyAssociationTo = function(model) {
	var self = this;
	Object.keys(this._associations).forEach(function(associationName) {
		var association = self._associations[associationName];

		// TODO: This (the below) is not working anymore. It seems not to be used anyway?

		if(association.manyAssociation && association.getAssociatedModel() == model) {
			self.removeProperty(association);
		}
	});
};

/**
 * Removes the property part of a one association to model.
 *
 * @access private
 *
 * @param {Model} model
 */
Model.prototype._removeOneAssociationTo = function(model) {
	var self = this;
	Object.keys(this._associations).forEach(function(associationName) {
		var association = self._associations[associationName];

		// TODO: This (the below) is not working anymore. It seems not to be used anyway?

		if(association.oneAssociation && association.getAssociatedModel() == model) {
			self.removeProperty(association);
		}
	});
};

/**
 * Removes a property from this model with the name of `property`. If the property to be removed is part of an association, also removes the association from the model and removes the property to this model from the associated model.
 *
 * If an active migration is set, sends the removal to the migration.
 *
 * @access private
 *
 * @param {Property} property The property to remove.
 */
Model.prototype.removeProperty = function(property) {
	if(this._activeMigration) {
		this._activeMigration.removeProperty(property);
	}

	delete this._properties[property.name];

	if(property.isAssociation()) {
		delete this._associations[property.name];

		// TODO: This (the below) is not working anymore. It seems not to be used anyway?

		// If this is a Many association, we might want to remove the original property
		if(property.manyAssociation) {
			property.getAssociatedModel()._removeOneAssociationTo(this);
		}
		else if(property.oneAssociation) {
			// TODO: this isn't really safe... there could be more associations really
			property.getAssociatedModel()._removeManyAssociationTo(this);
		}
	}
};

/**
 * Finds a property with a given key path. A key path is a string referring to a property or a property of any association.
 *
 * For example, given an Article model with an author association to the User model. The following key path would refer to the author's name: "author.name".
 *
 * @param {String} keyPath
 * @access private
 */
Model.prototype.getProperty = function(keyPath) {
	if(!keyPath) {
		throw new Error('Cannot find property with key path `null` (or `undefined`)');
	}

	var property = this._properties[keyPath];

	if(!property) {
		if(typeof keyPath == 'string') {
			var propertyNames = keyPath.split('.', 2);
			if(propertyNames.length > 1) {
				var firstProperty = this._properties[propertyNames[0]];
				var associatedModel;

				if(firstProperty.isManyToMany()) {
					associatedModel = firstProperty.options.through;
				}
				else {
					associatedModel = firstProperty.getAssociatedModel();
				}

				property = associatedModel.getProperty(propertyNames[1]);
			}
		}
		else {
			throw new Error('Model#getProperty keyPath must be a string, instead it is a ' + typeof keyPath + ' in model `' + this.getName() + '`.');
		}
	}

	return property;
};

Model.prototype.getMethods = function() {
	return this._methods;
};

/**
 * Returns all properties in a string-property dictionary.
 *
 * If the properties are not initialised yet, this internally creates the properties. In this phase the default `id` property is also created.
 *
 * @returns {Dictionary.<String, Property>}
 * @access private
 */
Model.prototype.getAllProperties = function() {
	if(!this._properties) {
		this._properties = {};

		// Now we create the default properties, currently only Id
		// There is a catch here: if it's already set by the user, we don't do anything
		// Even if it's set to something like [] (which gets ignored)
		if(!this.id) {
			this.id				= [this.UUID, this.CanUpdate(false)];
			this._properties.id = new Property('id', [this.UUID, this.CanUpdate(false)], this, this.models);
		}

		var propertyName;
		for(propertyName in this) {
			var propertyTypes = this[propertyName];
			if(typeof Model.prototype[propertyName] == 'undefined') {
				if(Array.isArray(propertyTypes)) {
					this._addProperty(propertyName, propertyTypes, true);
				}
				else if(typeof propertyTypes == 'function') {
					this._addMethod(propertyName, propertyTypes);
				}
			}
		}
	}

	return this._properties;
};

/**
 * Changes properties. Only called from migrations. During a migration, this alters columns in a table.
 *
 * @access private
 *
 * @param {Dictionary.<String, PropertyType[]>} properties
 */
Model.prototype.changeProperties = function(properties) {
	return this.addProperties(properties);
};

/**
 * Adds properties to the model and returns the added properties.
 *
 * If a property already exists, the property is overwritten.
 *
 * @access private
 *
 * @param {Dictionary.<String, PropertyType[]>}  properties
 * @param {Boolean} isNew      True if this is a new model, false if otherwise.
 */
Model.prototype.addProperties = function(properties, isNew) {
	var addedProperties = {};

	var self = this;
	Object.keys(properties).forEach(function(propertyName) {
		self[propertyName] = properties[propertyName];

		var property = self._addProperty(propertyName, properties[propertyName], isNew);
		if(property) {
			addedProperties[property.name] = property;
		}
	});

	this.models.postInstallModel(this);

	// Should we return this?
	return addedProperties;
};

/**
 * Edits a model's properties, adding, removing or altering properties.
 *
 * If an active migration is running, this edit is added as a task to the migration.
 *
 * @access private
 *
 * @param  {Property[]} addedProperties   [description]
 * @param  {Property[]} removedProperties [description]
 * @param  {Property[]} changedProperties [description]
 * @return {Mixed}                   A database result set. See {@link Datastore#query}.
 */
Model.prototype.edit = function(addedProperties, removedProperties, changedProperties) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}

		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	return this._table.alter(addedProperties, removedProperties, changedProperties);
};

/**
 * Removes properties from the model.
 *
 * @access private
 *
 * @param {String[]} propertyNames The names of the properties to remove.
 */
Model.prototype.removeProperties = function(propertyNames) {
	var self = this;
	propertyNames.forEach(function(propertyName) {
		delete self[propertyName];

		var property = self._properties[propertyName];

		self.removeProperty(property);
	});
};

/**
 * Sets up the model's table. This creates the table and is usually called from migrations.
 *
 * If an active migration is running, this is added as a task to the migration.
 *
 * @return {Mixed} The database result. See {@link Datastore#query}.
 *
 * @access private
 */
Model.prototype.setup = function() {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	return this._table.create();
};

/**
 * Creates a new model instance with the values from `setMap`.
 *
 * @access private
 *
 * @param  {Dictionary.<String, Mixed>} setMap - The values to set on the new model instance.
 * @return {Dictionary} The result from the databas.
 */
Model.prototype._create = function(setMap) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	return this._table.insert(setMap)
		.then(function(rows) {
			return rows[0];
		});
};

/**
 * Finds one or more model instances and updates them by invoking `updateFunction` for every instance. `updateFunction` uses dependency injection.
 *
 * This should be considered a slow approach to updating model instances, but is a convenient method to update many model instances with a dependency injection-aware method. Especially when implemented in a migration during the release stage.
 *
 * Consider a `User` model with slug properties which we want to update:
 * ```
 * UserModel.updateFunction({slug:''}, function(user, SlugService) {
 * 	user.slug = SlugService.slugify(user.name);
 * });
 * ```
 *
 * See {@link Model#find} for additional information. This method is not isomorphic and is only available on the back-end.
 */
Model.prototype.updateFunction = function(whereMap, optionsMap_, updateFunction_) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	var updateFunction, optionsMap;
	if(!updateFunction_) {
		updateFunction = optionsMap_;
		optionsMap = null;
	}
	else {
		optionsMap = optionsMap_;
		updateFunction = updateFunction_;
	}

	var self = this;
	return this.find(whereMap, optionsMap)
		.then(function(modelInstances) {
			var result = Q.when(true);

			modelInstances.forEach(function(modelInstance) {
				result = result.then(function() {
					var dependencyMap = {};
					dependencyMap[utils.lcfirst(self._name)] = modelInstance;
					return Q.when(self.models.app.injector.execute(updateFunction, dependencyMap))
						.then(function() {
							return modelInstance.save();
						});
				});
			});

			return result;
		});
};

/**
 * Updates model instances.
 *
 * @param  {Dictionary|String} whereMap
 * @param  {Dictionary} setMap
 * @param  {Dictionary} optionsMap Additional options to provide, similar to {@link Model#find}.
 * @param  {Number} optionsMap.limit Limits the number of instances to update to `limit`.
 * @param  {Number} optionsMap.skip Skips the first `skip` number of instances to update.
 * @param  {Dictionary<String, Mixed>} optionsMap.orderBy Orders the model instances to update. Please note: while using this works properly in combination with the skip and limit option, the returned model instances are returned in the correct order.
 * @return {Promise} Returns an array of model instances.
 */
Model.prototype.update = function(whereMap, setMap, optionsMap) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	var where;
	if(typeof whereMap == 'object') {
		where = this._transformWhereMap(whereMap || {});
	}
	else {
		where = {id: whereMap};
	}

	var options = optionsMap || {};
	var self = this;

	return Q.when(this._transformSetMap(setMap || {}, false))
		.then(function(set) {
			return self._table.update(where, set, options.limit, options.skip, options.orderBy);
		})
		.then(function(rows) {
			return self._createModelInstances(rows, 'afterUpdate', true);
		});
};

/**
 * Updates model instance with a limit of 1 and returns 1 model instance.
 *
 * @param {Dictionary|String} whereMapOrId Either a where map or UUID of the model instance.
 * @param {Dictionary} setMap The models to set.
 * @return {Promise} Resolves with 1 model instance.
 */
Model.prototype.updateOne = function(whereMap, setMap, optionsMap) {
	var options = optionsMap || {};
	options.limit = 1;

	return this.update(whereMap, setMap, options)
		.then(function(modelInstances) {
			if(modelInstances && modelInstances.length > 0) {
				return modelInstances[0];
			}
			else {
				return null;
			}
		});
};

/**
 * This is called by a model instance to invoke an update after {@link ModelInstance#save}.
 *
 * @access private
 *
 * @param {Dictionary} where The where clause.
 * @param {Dictionary} set   The properties to set.
 */
Model.prototype._updateOne = function(where, set) {
	return this._table.update(where, set, 1)
		.then(function(rows) {
			if(rows.length > 0) {
				return rows[0];
			}
			else {
				return null;
			}
		});
};

/**
 * Finds and resolves one model instance. See {@link Model#findOne}.
 *
 * This method is similar to Model#findOne, expect that it always resolves with a model instance, or rejects the returned promise. This is useful in certain flows where you don't want to check if a model instance is null.
 *
 * @return {Promise}
 */
Model.prototype.getOne = function(where, options) {
	return this.findOne(where, options)
		.then(function(model) {
			if(model) {
				return model;
			}
			else {
				var error = new Error('Not Found');
				error.status = 404;
				throw error;
			}
		})
		.catch(function(error) {
			throw error;
		});
};

/**
 * This method is flagged as confusing and will likely change in the near future.
 *
 * Checks whether the model's table is created.
 *
 * @access private
 *
 * @return {Promise} Boolean.
 */
Model.prototype.exists = function() {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	return this._table.exists();
};

/**
 * This is not implemented yet and will throw an error.
 *
 * Counts the number of model instances.
 *
 * @param  {Dictionary} whereMap There where clause. See {@link Model#find}.
 * @return {Promise} Resolves the number of model instances.
 *
 * @access private
 */
Model.prototype.count = function() {
	throw new Error('Not Implemented');
};

/**
 * Removes all model instances.
 *
 * This method is only available on the server-context.
 *
 * In the server-context:
 * ```
 * MyController.prototype.deleteUsers = function() {
 * 	return this.models.User.removeAll();
 * };
 * ```
 *
 * @access private
 */
Model.prototype.removeAll = function() {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	return this._table.remove({});
};

/**
 * Removes a model instance matching the where map.
 *
 * @param  {Dictionary} whereMap
 * @return {Promise}
 */
Model.prototype.remove = function(whereMap, optionsMap) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	var where = this._transformWhereMap(whereMap || {});

	var keys = Object.keys(where);
	if(!keys.length) {
		throw new Error('You are calling Model#remove without a `where` clause. This will result in removing all instances. This is disabled in Model#remove. Please invoke Model#removeAll instead.');
	}

	var options = optionsMap || {};

	var self = this;
	return this._table.remove(where, options.limit, options.skip, options.orderBy)
		.then(function(rows) {
			return self._createModelInstances(rows, null, true);
		});
};

Model.prototype.removeOne = function(whereMap, optionsMap) {
	var options = optionsMap || {};
	options.limit = 1;

	return this.remove(whereMap, options)
		.then(function(modelInstances) {
			if(modelInstances && modelInstances.length > 0) {
				return modelInstances[0];
			}
			else {
				return null;
			}
		});
};

/**
 * Finds a model instance, or creates one if it doesn't exist.
 *
 * If a model instance is not found, one is created by merging the whereMap and the setMap. If both the maps create the same key(s), setMap the value of setMap is used.
 *
 * This method simply executes Model#findOne followed by Model#create (if no model could be found). This method will be improved by using a writable CTE/WITH.
 *
 * @param {Dictionary} whereMap
 * @param {Dictionary} setMap
 */
Model.prototype.findOrCreate = function(where, set) {
	var self = this;
	return this.findOne(where)
		.then(function(model) {
			if(!model) {
				return self.create(utils.merge(where, set));
			}
			else {
				return model;
			}
		});
};

/**
 * Either updates a model instance, or creates a new model instance if not model exists.
 *
 * This method simply executes {@link Model#updateOne} followed by {@link Model#create} if no model could be updated. This method will be improved by using a writable CTE/WITH.
 *
 * @param {Dictionary} whereMap
 * @param {Dictionary} setMap
 */
Model.prototype.updateOrCreate = function(whereMap, setMap) {
	var self = this;
	return this.updateOne(whereMap, setMap)
		.then(function(modelInstance) {
			if(!modelInstance) {
				return self.create(utils.merge(whereMap, setMap));
			}
			else {
				return modelInstance;
			}
		});
};

Model.prototype._transformSetMap = function(setMap, isNew) {
	var properties = this.getAllProperties();

	var self = this;

	var result = Q.when(true);

	Object.keys(properties).forEach(function(propertyName) {
		var property = properties[propertyName];
		if(property.isTransformable()) {
			result = result.then(function() {
				return Q.when(self.models.app.injector.call(property.options.transformMethod, setMap || {}, self))
					.then(function(value) {
						if(typeof value != 'undefined') {
							setMap[property.name] = value;
						}
					});
			});
		}

		// If a change is set and the property type includes a hash, we'll hash it. Always.
		if(property.options.hashMethod && setMap[property.name]) {
			result = result.then(function() {
				return Q.when(property.options.hashMethod.call(self, setMap))
					.then(function(value) {
						setMap[property.name] = value;
					});
			});
		}

		// Let's check if this is a new model creation. If it's just an update we don't want to set a default value.
		// Unless the `changePropertyName` is set. Then we want to re-set the default value if the changePropertyName is also being updated.
		if(property.options.defaultValue) {
			if(property.options.defaultValue && (!setMap[property.name] && isNew || !isNew && typeof setMap[property.name] != 'undefined' && !setMap[property.name] || property.options.defaultChangePropertyName && setMap[property.options.defaultChangePropertyName])) {
				result = result.then(function() {
					return Q.when(property.options.defaultValue.call(self))
						.then(function(value) {
							setMap[property.name] = value;
						});
				});
			}
		}
	});

	return result
		.then(function() {
			return setMap;
		});
};

Model.prototype._transformWhereMap = function(whereMap) {
	var map = {};

	var self = this;
	Object.keys(whereMap).forEach(function(propertyName) {
		var value = whereMap[propertyName];
		if(propertyName.length > 1 && propertyName[0] == '$') {
			map[propertyName] = value;
		}
		else {
			var property = self.getProperty(propertyName);
			if(!property) {
				throw new Error('Cannot find property `' + propertyName + '` on `' + self._name + '`');
			}

			if(property.isSelectable()) {
				var selectMap = property.options.selectMethod.apply(self, [value]);
				Object.keys(selectMap || {}).forEach(function(key) {
					map[key] = selectMap[key];
				});
			}
			else if(property.options.hashMethod) {
				throw new Error('Property `' + propertyName + '` contains a hash method. It is not possible to query on a hash method directly.');
			}
			else {
				map[propertyName] = value;
			}
		}
	});

	return map;
};

/**
 * Finds one or more model instances.
 *
 * For example, given the following User model:
 * ```
 * function User() {
 * 	this.name = [this.String];
 * 	this.age = [this.Integer];
 * }
 * app.model(User);
 * ```
 *
 * In a controller in the client-context, to fetch up to 123 user's named "Martijn":
 * ```
 * function MyController(UserModel) {
 * 	UserModel.find({name: 'Martijn'}, {limit:123})
 * 		.then(function(users) {
 * 			//
 * 		});
 * }
 * app.controller(MyController);
 * ```
 *
 * The same example in a controller in the server-context:
 * ```
 * MyController.prototype.getMartijn = function() {
 * 	return this.models.User.find({name:'Martijn'}, {limit: 123});
 * };
 * ```
 *
 * The same example REST-style over HTTP:
 * ```
 * GET /api/users?name="Martijn"&$options={"limit":123}
 * ```
 *
 * @param  {Dictionary} whereMap The where clause.
 * @param {Dictionary} optionsMap Additional options for finding model instances, for example, ordering or selecting specific properties.
 * @param  {Number} optionsMap.limit Limits the number of model instances returned. This does not limit the number of associations returned. For example, if you have a User model with 3000 auto-fetched projects associated to it, all 3000 projects will be fetched even if you set the limit to 100. There is currently no way to limit the number of auto-fetched associations returned.
 * @param {Number} optionsMap.skip Skips the first number of model instances. This does not affect the associations.
 * @param  {Dictionary<String, Mixed>} optionsMap.orderBy Orders the model instances.
 * The value should be a dictionary with property name and value pairs. The value of a pair can either be a string (DESC, or ASC) or a number (-1 and lower for DESC and 0 and higher ASC).
 * @param {String|String[]} optionsMap.groupBy The property name(s) to group by.
 * @param  {String[]} optionsMap.select The properties to select. By default all properties are selected. If you specify an array only those properties are selected.
 *
 * This is useful if you want to limit the number of properties to fetch of the model and it's associations.
 *
 * To limit the properties to only `name` and `id` of the `User` model, see the example below. The `id` property is always included automatically.
 * ```
 * models.User.find({}, {select:['name']});
 * ```
 *
 * If the property is an non-auto fetched association, the association is not fetched automatically. To fetch non-auto fetched associations, use the `optionsMap.associations` key.
 *
 * You also need to specify the properties of any auto-fetched associations, else only their `id` property is returned. You can do this via the dot notation. For example, given a `User` model with a one-to-many `projects` association:
 * ```
 * models.User.find({name: 'Martijn'}, {select:['name', 'projects.name']})
 * 	.then(function(user) {
 * 		// user
 * 	});
 * ```
 *
 * You can also select all properties of an association by supplying a `*`:
 * ```
 * models.User.find({name: 'Martijn'}, {select:['name', 'projects.*']})
 * 	.then(function(user) {
 * 		// user
 * 	});
 * ```
 *
 * Please note if you try to access properties on a model instance not in the `select` list, the property's value will be undefined.
 *
 * @param  {Array} optionsMap.associations An array of property names of the associations to fetch. This is useful if you need an association but it's not configured as auto fetch (see {@link PropertyTypes#AutoFetch}).
 * @param {Number} optionsMap.autoFetchDepth The depth of associations of associations to fetch (if set to auto fetch). By default this is set to 5.
 * @return {Promise}           Resolves with an array of model instances. If no model instances are found, with an empty array is resolved.
 */
Model.prototype.find = function(whereMap, optionsMap, privateMap) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	var options = optionsMap || {};
	var where = whereMap || {};
	where = this._transformWhereMap(where);

	var self = this;
	return this._table.select(where, options.limit, options.skip, options.orderBy, options.groupBy, options.select, options.associations, options.autoFetchDepth)
		.then(function(rows) {
			return self._createModelInstances(rows, null, false, options.isShallow);
		});
};

/**
 * Creates model instances from a datastore result.
 *
 * @access private
 *
 * @param {Dictionary} datastoreResult The result object from a {@link Datastore#query} call.
 */
Model.prototype._createModelInstances = function(rows, hookName, isPartial, isShallow, privateMap) {
	// We can't simply pass all the rows to new model instances
	// We'll create an instance let is consumer rows, and the instance can decide if it rejects it
	var instances = [];
	var instance = null;

	// When there are many associations, we're sorting everything by id
	// TODO: We really shouldn't sort by id anymore--as it's a UUID now instead of a SERIAL.

	var self = this;
	rows.forEach(function(row) {
		if(!instance || !instance.consumeRow(row)) {
			instance = new ModelInstance(self, row, null, row.id, hookName, isPartial, isShallow, privateMap);
			instances.push(instance);
		}
	});

	return instances;
};

/**
 * Finds one model instance.
 *
 * @param {Dictionary} whereMap
 * @param {Dictionary} optionsMap
 * @return {Promise}
 */
Model.prototype.findOne = function(whereMap, optionsMap) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	var options = optionsMap || {};
	options.limit = 1;

	return this.find(whereMap, options)
		.then(function(instances) {
			if(instances.length) {
				return instances[0];
			}
			else {
				return null;
			}
		});
};

Model.prototype._findAuthenticator = function(request) {
	if(!request) {
		return Q.when(null);
	}

	var authenticatorModel = this.models.getAuthenticator();
	if(!authenticatorModel) {
		return Q.when(null);
	}

	return authenticatorModel.findMe(request);
};

Model.prototype.canCreate = function(createMaps, request) {
	var self = this;
	if(!request) {
		return Q.all([true, createMaps]);
	}

	return this._findAuthenticator(request)
		.then(function(authenticator) {
			return Q.all([self.getAccessControl(authenticator), authenticator]);
		})
		.spread(function(canCreate, authenticator) {
			if(!canCreate) {
				throw unauthenticatedError(authenticator);
			}
			else {
				if(self.options.automaticPropertyName) {
					// If a authenticator model does not exists there is some wrong.
					if(!self.models.getAuthenticator()) {
						throw new Error('Cannot find authenticator model. Did you define an authenticator via `PropertyTypes#Authenticate`?');
					}

					createMaps.forEach(function(createMap) {
						// This is definitely a bad request if the user tries to set the automatic property manually.
						if(createMap[self.options.automaticPropertyName]) {
							var error = new Error('Cannot set automatic property manually.');
							error.status = 400;
							throw error;
						}

						createMap[self.options.automaticPropertyName] = authenticator;
					});
				}

				return Q.all([true, createMaps]);
			}
		});
};

/**
 * Creates one or more model instance. This method is isomorphic and available on the back-end and the front-end.
 *
 * For example, to create one model instance in the back-end:
 * ```
 * app.controller('/sign-in', function AuthController($scope, UserModel) {
 * 	$scope.createUser = function(userMap) {
 * 		return UserModel.create(userMap);
 * 	};
 * });
 * ```
 *
 * You can also create multiple model instances when passing an array. When creating multiple model instances, they are created one-by-one in the database and no bulk-insert is performed. This is an improvement for a future release.
 *
 * @param  {Dictionary} createMap A dictionary to create one model instance, or an array to create multiple model instances.
 * @return {Promise}        			Either resolves with a model instance, or an array of model instances.
 */
Model.prototype.create = function(fields, privateMap) {
	if(Array.isArray(fields)) {
		return Q.all(fields.map(function(createMap) {
			return (new ModelInstance(this, null, createMap, null, null, true, false, privateMap)).save();
		}, this));
	}
	else {
		return (new ModelInstance(this, null, fields, null, null, true, false, privateMap)).save();
	}
};

/**
 * Destroys the model's table by dropping it. This even drops the model's table if any associations to any of the model instances exists.
 *
 * @access private
 */
Model.prototype.forceDestroy = function() {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	return this._table.drop(true);
};

/**
 * Destroys the model's table by dropping it.
 *
 * This method does not drop a table if any associations still exist. To force the drop, use Model#forceDestroy.
 *
 * @access private
 *
 * @return {Promise}
 */
Model.prototype.destroy = function() {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	return this._table.drop(false);
};

/**
 * Sets the permission of a given action on the model to a given key path or function.
 *
 * See AccessControl for more information.
 *
 * @access private
 *
 * @param {String} action                    The type of action: create, read, update, delete.
 * @param {String|Function} propertyKeyPathOrFunction
 */
Model.prototype.setAccessControl = function() {
	throw new Error('Model#setAccessControl is deprecate. Overwrite Model#accessControl instead.');
};

/**
 * Returns the models access control instance.
 *
 * @access private
 */
Model.prototype.getAccessControl = function() {
	if(!this._accessControl) {
		var accessControl = {};
		if(this.accessControl) {
			accessControl = this.accessControl();
		}

		this._accessControl = new AccessControl(this.models.app, accessControl);
	}

	return this._accessControl;
};

/**
 * This method is only available on the back-end.
 *
 * Executes an SQLish statement on the model. To execute a raw sql statement, see {@link Models#execute}.
 *
 * For example, on the back-end:
 * ```js
 * TestController.prototype.getTest = function() {
 * 	return this.models.Test.execute('SELECT * form tests');
 * };
 * ```
 *
 * @param  {String} sql    	SQLish statement.
 * @param  {Array} values 	An array of values
 * @return {Promise}        Resolves with an array of model instances. Even if the result is one model instance, an array is returned with just one model instance.
 */
Model.prototype.execute = function(sql, values) {
	if(this._activeMigration) {
		var args = new Array(arguments.length);
		for(var i = 0; i < args.length; ++i) {
			args[i] = arguments[i];
		}
		return this._activeMigration.addTask(this, utils.getMethodName(arguments.callee, Model.prototype), Array.prototype.splice.call(args, 0));
	}

	var self = this;
	return this._table.execute(sql, values)
		.then(function(rows) {
			return self._createModelInstances(rows, null, true);
		});
};

Model.prototype.accessControl = null;

Model.prototype.beforeCreate = null;
Model.prototype.afterCreate = null;
Model.prototype.afterSave = null;
Model.prototype.beforeSave = null;
Model.prototype.afterUpdate = null;
Model.prototype.beforeUpdate = null;
Model.prototype.afterLoad = null;
Model.prototype.beforeLoad = null;

Model.prototype.onForgotPassword = null;
Model.prototype.onResetPassword = null;
Model.prototype.onChangePassword = null;
