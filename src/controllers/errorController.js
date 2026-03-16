// const mongoose = require('mongoose');
// const Email = require('../utils/email');
const AppError = require('../utils/appError');
require('dotenv').config();

// Handle casting errors for MongoDB
const handleCastErrorDB = (err) => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  console.log('Cast Error', message);
  return new AppError(message, 400, { [err.path]: message });
};

// Handle BSON errors (Mongoose 7+ throws BSONError for invalid ObjectId)
const handleBSONError = (err) => {
  return new AppError('Invalid ID format', 400, { id: err.message });
};

// Error handling functions for MongoDB and other specific cases
const handleDuplicateFieldsDB = (err) => {
  const field = Object.keys(err.keyPattern)[0];
  const message = { [field]: `${field} already exist` };
  return new AppError('Duplicate field error', 400, message);
};
// `E11000 duplicate key error collection: ${err.message}`,

const handleValidationErrorDB = (err) => {
  const fieldErrors = {};
  Object.values(err.errors).forEach((error) => {
    fieldErrors[error.path] = error.message;
  });
  return new AppError('Validation error', 400, fieldErrors);
};

// JWT error handlers
const handleJWTError = () =>
  new AppError('Invalid token. Please log in again!', 401, {
    token: 'invalid token'
  });
const handleJWTExpiredError = () =>
  new AppError('Your token has expired! Please log in again.', 401, {
    token: 'Token expired'
  });

// Global error handler
const sendError = (err, error, req, res,next) => {
  const response = {
    status: 'fail', // Default to 500 if statusCode is not provided
    message: err.message || error.message || 'An error occurred'
  };

  // Include field-specific errors if present
  if (err.fieldErrors || error.fieldErrors) {
    response.error = err.fieldErrors || error.fieldErrors;
  }
  response.error = { ...response.error, [err.name]: err.message };
  return res.status(err.statusCode || 400).json(response);
};

module.exports = (err, req, res,next) => {
  console.log('err');
  console.log(err);
  console.log('err.name', err.name);

  let error = { ...err };
  error.message = err.message;

  // Customize MongoDB or JWT errors
  if (err.name === 'CastError') error = handleCastErrorDB(err);
  if (err.name === 'BSONError' || err.name === 'BSONTypeError') error = handleBSONError(err);
  if (err.code === 11000) error = handleDuplicateFieldsDB(err); // Duplicate key error
  if (err.name === 'ValidationError') error = handleValidationErrorDB(err);
  if (err.name === 'JsonWebTokenError') error = handleJWTError();
  if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();

  if (process.env.NODE_ENV !== 'production') {
    // Send full error details in development mode
    return sendError(err, error, req, res);
  }

  // Send formatted error response
  return sendError(error, error, req, res);
};
