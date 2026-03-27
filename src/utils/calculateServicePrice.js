const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const Bookings = require('../models/Bookings');
const Calendar = require('../models/Calendar');

dayjs.extend(duration);
dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);

const getServiceBookingPrice = (
  pricingModel,
  checkIn,
  checkOut,
  serviceDays,
  addOnServices,
  serviceInfo
) => {
  if (
    !pricingModel ||
    !checkIn ||
    !checkOut ||
    !Array.isArray(serviceDays) ||
    serviceDays.length === 0
  ) {
    return 0;
  }

  

  // extra add-ons
  const servicePriceValue = addOnServices?.reduce(
    (acc, curr) => acc + Number(curr.price || 0),
    0
  );

  // service timezone (fallback UTC)
  const serviceTimezone = serviceInfo?.timezone || "UTC";
  console.log('TimeZone', serviceTimezone);

 const start = dayjs.utc(checkIn).tz(serviceTimezone);
  const end = dayjs.utc(checkOut).tz(serviceTimezone);
  if (!end.isAfter(start)) return 0;
  let totalPrice = 0;
  let current = start.startOf("day");
  while (current.isSameOrBefore(end, "day")) {
    const dayName = current.format("dddd").toLowerCase();
    const dayInfo = serviceDays.find((sd) => sd.day === dayName);
    if (dayInfo && dayInfo.price) {
      const dayPrice = Number(dayInfo.price) || 0;
      const dayDateStr = current.format("YYYY-MM-DD");
      let serviceStart = dayjs.tz(
        `${dayDateStr} ${dayInfo.startTime}`,
        "YYYY-MM-DD HH:mm",
        serviceTimezone
      );
      let serviceEnd = dayjs.tz(
        `${dayDateStr} ${dayInfo.endTime}`,
        "YYYY-MM-DD HH:mm",
        serviceTimezone
      );
      if (serviceEnd.isBefore(serviceStart)) {
        serviceEnd = serviceEnd.add(1, "day"); // overnight
      }
      const checkInLocal = start;
      const checkOutLocal = end;
      if (pricingModel === "hourly") {
        if (
          checkOutLocal.isAfter(serviceStart) &&
          checkInLocal.isBefore(serviceEnd)
        ) {
          const actualStart = checkInLocal.isAfter(serviceStart)
            ? checkInLocal
            : serviceStart;
          const actualEnd = checkOutLocal.isBefore(serviceEnd)
            ? checkOutLocal
            : serviceEnd;
          if (actualEnd.isAfter(actualStart)) {
            const hours = dayjs.duration(actualEnd.diff(actualStart)).asHours();
            totalPrice += hours * dayPrice;
          }
        }
      } else if (pricingModel === "daily") {
        if (
          checkInLocal.isBefore(serviceEnd) &&
          checkOutLocal.isAfter(serviceStart)
        ) {
          totalPrice += dayPrice;
        }
      }
    }
    current = current.add(1, "day");
  }


  return parseFloat(totalPrice.toFixed(2)) + servicePriceValue;
};

const checkBookingDates = async (checkIn, checkOut, listingExists, service) => {
  console.log('service', service);
  const existingBooking = await Bookings.findOne({
    service: service,
    checkIn: { $lt: new Date(checkOut) },
    checkOut: { $gt: new Date(checkIn) }
  });
  const checkCalendar = await Calendar.findOne({
    $or: [
      {
        serviceId: service,
        start: { $lt: new Date(checkOut) },
        end: { $gt: new Date(checkIn) }
      },
      {
        userId: listingExists?.vendorId?._id.toString(),
        start: { $lt: new Date(checkOut) },
        end: { $gt: new Date(checkIn) }
      }
    ]
  });

  console.log('existingBooking', existingBooking);
  console.log('checkCalendar', checkCalendar);

  if (existingBooking) {
    throw new Error('This service is already booked for the selected dates.', 400);
  }
  if (checkCalendar) {
    throw new Error('This service is already booked or reserved for the selected dates.', 400);
  }

  if (listingExists?.vendorId?.SleepMode === true) {
    throw new Error('This listing is currently unavailable because it is in sleep mode', 400);
  }

  return { existingBooking, checkCalendar };
};

const checkBookingDatesForExtension = (pricingModel, checkIn, checkOut, serviceDays) => {
  if (
    !pricingModel ||
    !checkIn ||
    !checkOut ||
    !Array.isArray(serviceDays) ||
    serviceDays.length === 0
  ) {
    return 0;
  }

  let totalDuration = 0;

  const start = dayjs(checkIn);
  const end = dayjs(checkOut);
  if (pricingModel === 'daily' && start.isSame(end)) {
    return 0;
  }

  let current = start.startOf('day');

  while (current.isSameOrBefore(end, 'day')) {
    const dayName = current.format('dddd').toLowerCase();
    const dayInfo = serviceDays.find((sd) => sd.day === dayName);
    if (dayInfo) {
      const dayDateStr = current.format('YYYY-MM-DD');
      let serviceStart = dayjs(`${dayDateStr} ${dayInfo.startTime}`, 'YYYY-MM-DD HH:mm').local();
      let serviceEnd = dayjs(`${dayDateStr} ${dayInfo.endTime}`, 'YYYY-MM-DD HH:mm').local();
      if (serviceEnd.isBefore(serviceStart)) {
        serviceEnd = serviceEnd.add(1, 'day'); // Handle overnight
      }
      const checkInLocal = dayjs(checkIn).local();
      const checkOutLocal = dayjs(checkOut).local();

      if (pricingModel === 'hourly') {
        // Calculate only overlapping hours
        if (checkOutLocal.isAfter(serviceStart) && checkInLocal.isBefore(serviceEnd)) {
          const actualStart = checkInLocal.isAfter(serviceStart) ? checkInLocal : serviceStart;
          const actualEnd = checkOutLocal.isBefore(serviceEnd) ? checkOutLocal : serviceEnd;
          if (actualEnd.isAfter(actualStart)) {
            const hours = dayjs.duration(actualEnd.diff(actualStart)).asHours();
            totalDuration += hours;
          }
        }
      } else if (pricingModel === 'daily') {
        // Only count if booking overlaps service hours
        if (checkOutLocal.isAfter(serviceStart) && checkInLocal.isBefore(serviceEnd)) {
          totalDuration += 1; // 1 day
        }
      }
    }
    current = current.add(1, 'day');
  }

  return parseFloat(totalDuration.toFixed(2));
};

/**
 * Check if buffer time is available between bookings
 * @param {Date} checkInTime - Proposed check-in time
 * @param {Date} checkOutTime - Proposed check-out time
 * @param {String} serviceId - Service ID
 * @param {Number} bufferTime - Buffer time amount
 * @param {String} bufferTimeUnit - Buffer time unit ('minutes' or 'hours')
 * @param {String} durationUnit - Service duration unit ('days', 'minutes', 'hours')
 * @param {Number} minimumDuration - Minimum duration required for the service
 * @returns {Promise<Object>} - { available: boolean, conflictingBooking: object|null, reason: string }
 */
const checkBufferTimeAvailability = async (
  checkInTime,
  checkOutTime,
  serviceId,
  bufferTime = 0,
  bufferTimeUnit = 'minutes',
  durationUnit = 'hours',
  minimumDuration = 0,
  timezone = 'UTC',
  bookingId = null
) => {
  try {
    // Convert buffer time to minutes for consistent calculation
    let bufferInMinutes = bufferTime;
    if (bufferTimeUnit === 'hours') {
      bufferInMinutes = bufferTime * 60;
    }

    // Convert minimum duration to minutes based on unit
    let minDurationInMinutes = minimumDuration;
    if (durationUnit === 'days') {
      minDurationInMinutes = minimumDuration * 24 * 60;
    } else if (durationUnit === 'hours') {
      minDurationInMinutes = minimumDuration * 60;
    }

    const checkIn = new Date(checkInTime);
    const checkOut = new Date(checkOutTime);

    // Check if proposed booking duration meets minimum requirement
    const bookingDurationMinutes = (checkOut - checkIn) / (1000 * 60);
    if (minimumDuration > 0 && bookingDurationMinutes < minDurationInMinutes) {
      return {
        available: false,
        conflictingBooking: null,
        reason: `Booking duration must be at least ${minimumDuration} ${durationUnit}`
      };
    }

    // Find only overlapping bookings for this service with the proposed dates
    // This checks if there's any booking that conflicts with the proposed time slot
    const query = {
      service: serviceId,
      status: { $in: ['booked', 'pending'] },
      isDeleted: false,
      checkIn: { $lt: new Date(checkOut + bufferInMinutes * 60 * 1000) },
      checkOut: { $gt: new Date(checkIn - bufferInMinutes * 60 * 1000) }
    };
    if (bookingId !== null && bookingId !== undefined) {
      query._id = { $ne: bookingId }; // Exclude current booking if checking for extension
    }
    const conflictingBookings = await Bookings.findOne(query);

    console.log('conflictingBookings', conflictingBookings,'checkIn', new Date(checkIn - bufferInMinutes * 60 * 1000));


    if (!conflictingBookings) {
      return { available: true, conflictingBooking: null, reason: null };
    }

    // Apply buffer time to check if new booking fits with existing booking
    // New booking can start after existing booking + buffer
    const existingCheckOut = new Date(conflictingBookings.checkOut);
    const bufferEndTime = new Date(existingCheckOut.getTime() + bufferInMinutes * 60 * 1000);

    // New booking can end before existing booking - buffer
    const existingCheckIn = new Date(conflictingBookings.checkIn);
    const bufferStartTime = new Date(existingCheckIn.getTime() - bufferInMinutes * 60 * 1000);

    // Convert times to local timezone for user-friendly messages
    const bufferEndTimeLocal = dayjs(bufferEndTime).tz(timezone).format('YYYY-MM-DD HH:mm:ss');
    const bufferStartTimeLocal = dayjs(bufferStartTime).tz(timezone).format('YYYY-MM-DD HH:mm:ss');

    // Check if new booking overlaps with buffer zones
    if (checkOut > bufferStartTime && checkIn < bufferEndTime) {
      return {
        available: false,
        conflictingBooking: {
          checkIn: conflictingBookings.checkIn,
          checkOut: conflictingBookings.checkOut,
          bufferStartTime,
          bufferEndTime
        },
        reason: `Service is not available. Previous booking ends at ${bufferEndTimeLocal} (${timezone}). Next available time after buffer: ${bufferEndTimeLocal} (${timezone})`
      };
    }

    return { available: true, conflictingBooking: null, reason: null };
  } catch (error) {
    throw new Error(`Buffer time availability check failed: ${error.message}`);
  }
};

module.exports = { getServiceBookingPrice, checkBookingDates, checkBookingDatesForExtension, checkBufferTimeAvailability };
