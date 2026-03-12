const  {Category, Amenities}= require('../models/Amenities');
const ServiceCategory = require('../models/ServiceCategory');


// Define the amenity data with categories and which service types they apply to
// serviceTypeNames: array of service type names that this amenity group applies to
// If empty, applies to ALL service types
const AllAmenities = [
  {
    name: "Venues Amenities",
    serviceTypeNames: ["Venues"],
    categories: [
      { name: "Bridal Suite" },
      { name: "Outdoor" },
      { name: "Microwave" },
      { name: "Fridge" },
      { name: "Buffet Area" },
      { name: "Wheelchair accessible" },
      { name: "Outside alcohol allowed" },
      { name: "Indoor" },
      { name: "Stove" },
      { name: "Kitchen" },
      { name: "Tables & Chairs" },
      { name: "Elevator" },
      { name: "Dressing Room" },
      { name: "Outside food allowed" },
      { name: "Coolers" },
      { name: "Bar" },
      { name: "Stairs" },
      { name: "Ground floor" }
    ]
  },
  {
    name: "DJ Amenities",
    serviceTypeNames: ["DJ's"],
    categories: [
      { name: "Sound System" },
      { name: "Lighting" },
      { name: "Microphone" },
      { name: "Fog Machine" },
      { name: "LED Screen" },
      { name: "Speakers" },
      { name: "Mixer" },
      { name: "Subwoofer" },
      { name: "Wireless Mic" }
    ]
  },
  {
    name: "Catering Amenities",
    serviceTypeNames: ["Catering"],
    categories: [
      { name: "Buffet Style" },
      { name: "Plated Service" },
      { name: "Food Warmers" },
      { name: "Chafing Dishes" },
      { name: "Serving Staff" },
      { name: "Disposable Plates" },
      { name: "Linen Napkins" },
      { name: "Drink Station" },
      { name: "Dessert Table" },
      { name: "Dietary Options" }
    ]
  },
  {
    name: "Decoration Amenities",
    serviceTypeNames: ["Decorations"],
    categories: [
      { name: "Balloon Arrangements" },
      { name: "Flower Arrangements" },
      { name: "Table Centerpieces" },
      { name: "Backdrop" },
      { name: "Draping" },
      { name: "Candles" },
      { name: "String Lights" },
      { name: "Arch" },
      { name: "Chair Covers" }
    ]
  },
  {
    name: "Entertainment Amenities",
    serviceTypeNames: ["Entertainment"],
    categories: [
      { name: "Live Band" },
      { name: "MC / Host" },
      { name: "Sound System" },
      { name: "Stage" },
      { name: "Karaoke" },
      { name: "Photo Booth" },
      { name: "Games" },
      { name: "Performers" }
    ]
  },
  {
    name: "Photography & Videography Amenities",
    serviceTypeNames: ["Photography & Videography"],
    categories: [
      { name: "Drone Coverage" },
      { name: "Photo Editing" },
      { name: "Video Editing" },
      { name: "Photo Album" },
      { name: "Digital Gallery" },
      { name: "Same-Day Edit" },
      { name: "Green Screen" },
      { name: "Props" },
      { name: "Second Shooter" }
    ]
  },
  {
    name: "Beauty Amenities",
    serviceTypeNames: ["Beauty"],
    categories: [
      { name: "Hair Styling" },
      { name: "Makeup" },
      { name: "Nails" },
      { name: "Lashes" },
      { name: "Bridal Package" },
      { name: "Touch-Up Kit" },
      { name: "Travel to Venue" },
      { name: "Trial Session" }
    ]
  },
  {
    name: "Fashion Amenities",
    serviceTypeNames: ["Fashion"],
    categories: [
      { name: "Custom Tailoring" },
      { name: "Fittings" },
      { name: "Alterations" },
      { name: "Rental Available" },
      { name: "Accessories" },
      { name: "Delivery" }
    ]
  },
  {
    name: "Transportation Amenities",
    serviceTypeNames: ["Transportation"],
    categories: [
      { name: "Luxury Vehicle" },
      { name: "Party Bus" },
      { name: "Shuttle Service" },
      { name: "Chauffeur" },
      { name: "Red Carpet" },
      { name: "Decorations Included" },
      { name: "Multiple Stops" },
      { name: "Airport Pickup" }
    ]
  },
  {
    name: "Cakes Amenities",
    serviceTypeNames: ["Cakes"],
    categories: [
      { name: "Custom Design" },
      { name: "Fondant" },
      { name: "Buttercream" },
      { name: "Multi-Tier" },
      { name: "Cupcakes" },
      { name: "Cake Topper" },
      { name: "Gluten Free" },
      { name: "Vegan Option" },
      { name: "Delivery & Setup" },
      { name: "Tasting Available" }
    ]
  },
  {
    name: "Equipment Amenities",
    serviceTypeNames: ["Equipment"],
    categories: [
      { name: "Tents" },
      { name: "Generators" },
      { name: "Portable AC" },
      { name: "Heaters" },
      { name: "Stage / Platform" },
      { name: "Dance Floor" },
      { name: "Portable Restrooms" },
      { name: "Lighting Rigs" },
      { name: "Power Distribution" }
    ]
  },
  {
    name: "Staff Amenities",
    serviceTypeNames: ["Staff"],
    categories: [
      { name: "Waitstaff" },
      { name: "Bartenders" },
      { name: "Security" },
      { name: "Valet Parking" },
      { name: "Event Coordinator" },
      { name: "Setup & Cleanup Crew" },
      { name: "Coat Check" },
      { name: "Ushers" }
    ]
  }
];

const populateAmenities = async () => {
  try {
    // Clear existing amenities and categories
    await Amenities.deleteMany({});
    console.log('Existing amenities deleted.');

    // Clear existing categories to prevent duplicates
    await Category.deleteMany({});
    console.log('Existing categories deleted.');

    // Load all service categories for linking
    const allServiceTypes = await ServiceCategory.find();

    // Process each amenity to create categories and associate them
    for (const amenity of AllAmenities) {
      const categoryIds = [];

      // Create categories and push their IDs into categoryIds array
      for (const category of amenity.categories) {
        const existingCategory = await Category.findOne({ name: category.name });
        if (!existingCategory) {
          // If category doesn't exist, create a new one
          const newCategory = await Category.create({ name: category.name });
          categoryIds.push(newCategory._id);
        } else {
          categoryIds.push(existingCategory._id);
        }
      }

      // Resolve service type names to IDs
      const serviceTypeIds = (amenity.serviceTypeNames || [])
        .map(name => allServiceTypes.find(st => st.name === name)?._id)
        .filter(Boolean);

      // Create the amenity with category references and service type links
      const newAmenity = await Amenities.create({
        name: amenity.name,
        categories: categoryIds,
        serviceTypes: serviceTypeIds
      });
      console.log(`Amenity '${newAmenity.name}' added successfully! (linked to: ${amenity.serviceTypeNames?.join(', ') || 'all'})`);
    }

    console.log('All amenities and categories added successfully!');
  } catch (error) {
    console.error('Error populating amenities:', error);
  }
}

module.exports = populateAmenities;

