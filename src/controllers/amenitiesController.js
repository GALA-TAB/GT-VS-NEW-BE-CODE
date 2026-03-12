const { Category, Amenities } = require('../models/Amenities');

const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

// Get All Amenities with Populated Categories (optionally filtered by service type)
const getAllAmenities = catchAsync(async (req, res) => {
  const { serviceType } = req.query;
  const filter = {};
  if (serviceType) {
    filter.serviceTypes = serviceType;
  }
  const amenities = await Amenities.find(filter).populate('categories');

  return res.status(200).json({
    status: 'success',
    results: amenities.length,
    data: amenities
  });
});

// Create Amenity with Categories
const createAmenity = catchAsync(async (req, res, next) => {
  const { name: AmenityName, categories } = req.body;

  // Validate Amenity name
  if (!AmenityName || typeof AmenityName !== 'string') {
    return next(new AppError('Please provide Amenity name', 400));
  }

  // Validate categories (ensure it's an array)
  if (!Array.isArray(categories)) {
    return next(new AppError('Categories should be an array of names', 400));
  }

  // Create categories and get their IDs
  const createdCategories = [];
  for (const categoryName of categories) {
    const existingCategory = await Category.findOne({ name: categoryName });
    if (existingCategory) {
      createdCategories.push(existingCategory._id); // Push existing category ID if found
    } else {
      // If category doesn't exist, create it
      const newCategory = await Category.create({ name: categoryName });
      createdCategories.push(newCategory._id); // Push newly created category ID
    }
  }

  // Create the Amenity with the category IDs
  const newAmenity = await Amenities.create({
    name: AmenityName,
    categories: createdCategories // Store category IDs in the amenities model
  });

  res.locals.dataId = newAmenity._id; // Store the ID of the created Amenity in res.locals
  return res.status(201).json({
    status: 'success',
    data: newAmenity
  });
});

// Delete Amenity
const deleteAmenity = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) {
    return next(new AppError('Please provide Amenity id', 400));
  }
  console.log('Deleting Amenity with ID:', id);

  const deletedAmenity = await Amenities.findByIdAndDelete(id);
  await Category.deleteMany({ _id: { $in: deletedAmenity?.categories } });
  if (!deletedAmenity) {
    return next(new AppError('No amenity found with that ID', 404));
  }

  return res.status(204).json({
    status: 'success',
    data: null
  });
});
const deleteAmenityCategory = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) {
    return next(new AppError('Please provide Amenity id', 400));
  }
  const deletedAmenity = await Category.findByIdAndDelete(id);
  if (!deletedAmenity) {
    return next(new AppError('No amenity found with that ID', 404));
  }

  return res.status(204).json({
    status: 'success',
    message: 'Amenity Category deleted successfully',
    data: null
  });
});

// Add Category to Amenity
const addCategoryToAmenity = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { categoryName } = req.body;

  if (!id) {
    return next(new AppError('Please provide Amenity id', 400));
  }

  if (!categoryName || typeof categoryName !== 'string') {
    return next(new AppError('Please provide Category name', 400));
  }

  const Amenity = await Amenities.findById(id).populate('categories');
  if (!Amenity) {
    return next(new AppError('No Amenity found with that ID', 404));
  }

  const isCategoryAlreadyExist = Amenity.categories.find(
    (category) => category.name === categoryName
  );
  if (isCategoryAlreadyExist) {
    return next(new AppError(`Category ${categoryName} is already exist in Amenity`, 400));
  }

  // If category doesn't exist, create it
  const existingCategory = await Category.findOne({ name: categoryName });
  let categoryId;
  if (existingCategory) {
    categoryId = existingCategory._id;
  } else {
    const newCategory = await Category.create({ name: categoryName });
    categoryId = newCategory._id;
  }

  // Add the category ID to the Amenity
  Amenity.categories.push(categoryId);
  await Amenity.save();
  res.locals.dataId = Amenity._id; // Store the ID of the updated Amenity in res.locals

  return res.status(201).json({
    status: 'success',
    data: Amenity
  });
});

module.exports = {
  getAllAmenities,
  createAmenity,
  deleteAmenity,
  addCategoryToAmenity,
  deleteAmenityCategory
};
