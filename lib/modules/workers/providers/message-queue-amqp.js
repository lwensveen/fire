'use strict';

exports = module.exports = MessageQueueAMQP;

var MessageQueue = require('./../message-queue');

var amqp = require('amqplib');
var util = require('util');
var Q = require('q');
var debug = require('debug')('fire:amqp');

/**
 * AMQP implemention of the message queue.
 *
 * @param {String} connectionString The connection string. This is the `AMQP_URL` environment variable.
 */
function MessageQueueAMQP(connectionString) {
	MessageQueue.call(this, connectionString);

	this.connection = null;
}
util.inherits(MessageQueueAMQP, MessageQueue);

/**
 * Connects to the AMQP instance e.g. RabbitMQ.
 *
 * @return {Promise}
 */
MessageQueueAMQP.prototype.connect = function() {
	var self = this;
	return amqp.connect(this.connectionString)
		.then(function(connection) {
			self.connection = connection;
		});
};

/**
 * Disconnections from the AMQP instance.
 *
 * @return {Promise}
 */
MessageQueueAMQP.prototype.disconnect = function() {
	return this.connection.close();
};

/**
 * Creates a channel and publishes a message to queue named `queueName`. The message is a JSON dictionary with key `methodName` and `params`.
 *
 * @param {String} queueName
 * @param {String} methodName
 * @param {Array} params
 */
MessageQueueAMQP.prototype.publishMessage = function(queueName, methodName, params) {
	return this.connection.createChannel()
		.then(function(channel) {
			channel.assertQueue(queueName);
			return channel.sendToQueue(queueName, new Buffer(JSON.stringify({
				methodName: methodName,
				params: params
			})));
		});
};

/**
 * Starts consuming message on the given queue. Each message gets serialized to a dictionary with key `methodName` and `params` (which are the original method's name with it's arguments invoked on the specific worker).
 *
 * @param {String}   queueName The name of the queue.
 * @param {Function} callback  The callback invoked whenever a new message is received. The message is acknowledged only if the callback resolves the returned promise. The message is not acknowledged when the callback returns and rejects the returned promise.
 */
MessageQueueAMQP.prototype.startConsuming = function(queueName, callback) {
	return this.connection.createChannel()
		.then(function(channel) {
			channel.assertQueue(queueName);

			channel.consume(queueName, function(message) {
				// Normalize the message to a standard format so we can switch message queue providers.
				var messageMap = JSON.parse(message.content);

				Q.when(callback(messageMap))
					.then(function() {
						// Acknowledge the message if we didn't encounter an error.
						channel.ack(message);
					})
					.fail(function(error) {
						// We are not acknoldiging the message if the callback rejects with an error.

						// TODO: Should we send a nack message?

						debug(error);
					})
					.done();
			});
		});
};