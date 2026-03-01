/**
 * createLog — write an activity entry to the Logs collection.
 *
 * Usage:
 *   await createLog({ actorId, actorModel, action, description, target, targetId });
 *
 * Never throws — logging failures should never break the primary request.
 */
const Log = require('../models/Logs');

/**
 * @param {object} opts
 * @param {string|ObjectId} opts.actorId      - The _id of the user performing the action
 * @param {string}          opts.actorModel   - 'admin' | 'vendor' | 'customer'
 * @param {string}          opts.action       - Short machine-readable key e.g. 'LOGIN', 'CREATE_BOOKING'
 * @param {string}          [opts.description]- Human-readable sentence
 * @param {string}          [opts.target]     - Target model name e.g. 'Booking', 'Service'
 * @param {string|ObjectId} [opts.targetId]   - _id of the affected document
 * @param {string}          [opts.ipAddress]  - Optional IP of the requester
 */
const createLog = async ({
  actorId,
  actorModel,
  action,
  description = null,
  target = null,
  targetId = null,
  ipAddress = null,
} = {}) => {
  if (!actorId || !actorModel || !action) return; // silently bail if missing required fields

  // Normalise actorModel — the DB enum is lowercase
  const normalisedModel = actorModel?.toLowerCase?.();
  const allowedModels = ['admin', 'vendor', 'customer'];
  const resolvedModel = allowedModels.includes(normalisedModel) ? normalisedModel : 'admin';

  try {
    await Log.create({
      actorId,
      actorModel: resolvedModel,
      action,
      description,
      target,
      targetId: targetId || undefined,
      ipAddress,
    });
  } catch (err) {
    // Never let a logging failure crash the request
    console.error('[createLog] Failed to write log entry:', err.message);
  }
};

module.exports = createLog;
