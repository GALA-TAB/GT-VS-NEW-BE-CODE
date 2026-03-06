const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const User = require('../models/users/User');

/**
 * Optional authentication middleware.
 * If a valid JWT token is present, populates req.user.
 * If no token or invalid token, continues without error (req.user stays undefined).
 * Used for public routes that optionally reveal more data to authenticated users.
 */
module.exports = async (req, res, next) => {
  try {
    const { authorization } = req.headers;
    if (!authorization) return next();

    const token = authorization.split(' ')[1];
    if (!token) return next();

    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
    const currentUser = await User.findById(decoded?.user?._id).select('_id role');
    if (currentUser && currentUser.status !== 'Delete' && !currentUser.isDeactivated) {
      req.user = currentUser;
    }
  } catch {
    // Token invalid or expired — continue as unauthenticated
  }
  return next();
};
