const { verify } = require('jsonwebtoken');
const catchAsync = require('../catchAsync');

const { STRIPE_SECRET_ACCESS_KEY } = process.env;
const stripe = STRIPE_SECRET_ACCESS_KEY ? require('stripe')(STRIPE_SECRET_ACCESS_KEY) : null;

module.exports = {
  createCustomer: async (params) => {
    const { email, name } = params;
    try {
      const customer = await stripe.customers.create({
        email,
        name
      });
      return customer;
    } catch (error) {
      console.error('Error creating customer:', error);
      throw new Error(error);
    }
  },

  attachPaymentMethod: async (params) => {
    const { paymentMethodId, customerId } = params;
    try {
      const paymentMethod = await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId
      });
      return paymentMethod;
    } catch (error) {
      console.error('Error attaching payment method:', error);
      throw new Error(error);
    }
  },

  getCustomer: async (params) => {
    const { customerId } = params;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      return customer;
    } catch (error) {
      console.error('Error retrieving customer:', error);
      throw new Error(error);
    }
  },

  updateCustomer: async (params) => {
    const { stripeCustomerId, paymentMethodid } = params;
    try {
      // Set default payment method
      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: {
          default_payment_method: paymentMethodid
        }
      });
    } catch (error) {
      console.error('Error updating customer:', error);
      throw new Error(error);
    }
  },

  deleteCustomer: async (params) => {
    const { customerId } = params;
    try {
      const customer = await stripe.customers.del(customerId);
      return customer;
    } catch (error) {
      console.error('Error deleting customer:', error);
      throw new Error(error);
    }
  },

  listCustomers: async (params) => {
    const { limit } = params;
    try {
      const customers = await stripe.customers.list({
        limit
      });
      return customers;
    } catch (error) {
      console.error('Error listing customers:', error);
      throw new Error(error);
    }
  },

  retrievePaymentMethod: async (params) => {
    const { paymentMethodId } = params;
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentMethodId);

      if (paymentIntent.status === 'requires_confirmation') {
        await stripe.paymentIntents.confirm(paymentMethodId);
      }

      return paymentIntent;
    } catch (error) {
      console.error('Error retrieving payment method:', error);
      throw new Error(error);
    }
  },

  capturePaymentIntent: async (params) => {
    const { paymentIntentId } = params;
    try {
      const capturedPayment = await stripe.paymentIntents.capture(paymentIntentId, {
        expand: ['payment_method']
      });
      return capturedPayment;
    } catch (error) {
      console.error('Error capturing payment intent:', error);
      throw new Error(error);
    }
  },
  cancelPaymentIntent: async (params) => {
    const { paymentIntentId } = params;
    try {
      // Stripe errors if the intent is already canceled (e.g. authorization expired), so treat that as done
      const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (existing.status === 'canceled') {
        return existing;
      }
      const canceledPayment = await stripe.paymentIntents.cancel(paymentIntentId);
      return canceledPayment;
    } catch (error) {
      console.error('Error canceling payment intent:', error);
      throw new Error(error);
    }
  },
  refundPaymentIntent: async (params) => {
    const { paymentIntentId, amount } = params;
    try {
      const refundedPayment = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount
      });
      return refundedPayment;
    } catch (error) {
      console.error('Error refunding payment intent:', error);
      throw new Error(error);
    }
  },
  refundPaymentIntentfromConnectedAccount: async (params) => {
    try {
      const { paymentIntentId, amount, connectedAccountId } = params;
      console.log('Refunding from connected account:', {
        paymentIntentId,
        amount,
        connectedAccountId
      });

      const refundedPayment = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount
        },
        {
          stripeAccount: connectedAccountId
        }
      );

      return refundedPayment;
    } catch (error) {
      console.error('Error refunding payment intent:', error);
      throw new Error(error);
    }
  },
  createCoupon: async (params) => {
    const { discountData } = params;
    try {
      const coupondata = {
        id: discountData?.discountCode,
        name: discountData?.discountCode,
        duration: 'forever', // or 'repeating' / 'forever'
        max_redemptions: discountData.maxTotalUsage,
        currency: 'usd', // or the currency you are using
        redeem_by: Math.floor(new Date(discountData.endDate).getTime() / 1000) // Unix timestamp
      };
      if (discountData.discountType === 'Percentage') {
        coupondata.percent_off = discountData.percentage;
      } else {
        coupondata.amount_off = discountData.maxDiscount * 100; // Convert to cents
      }
      const coupon = await stripe.coupons.create(coupondata);
      return coupon;
    } catch (error) {
      console.error('Error creating coupon:', error);
      throw new Error(error);
    }
  },
  verifyCoupon: async (params) => {
    const { couponCode } = params;
    try {
      const coupon = await stripe.coupons.retrieve(couponCode);
      console.log(coupon, 'coupons list from stripe');
      const now = Math.floor(Date.now() / 1000);
      if (coupon.redeem_by && now > coupon.redeem_by) {
        throw new Error('Coupon has expired.');
      }

      if (coupon.max_redemptions && coupon.times_redeemed >= coupon.max_redemptions) {
        throw new Error('Coupon usage limit reached.');
      }

      // Coupon is valid
      console.log('Coupon verified:', coupon);
      return coupon;
    } catch (err) {
      console.log(err, 'these are error');
      throw new Error(err?.message);
    }
  },
  updateCoupon: async (params) => {
    const { oldCouponCode, discountData } = params;
    try {
      // Stripe coupons are immutable, so we need to delete the old one and create a new one
      // First, delete the old coupon
      await stripe.coupons.del(oldCouponCode);
      console.log(`Old coupon ${oldCouponCode} deleted from Stripe`);

      // Then create a new coupon with updated data
      const coupondata = {
        id: discountData?.discountCode,
        name: discountData?.discountCode,
        duration: 'forever',
        max_redemptions: discountData.maxTotalUsage,
        currency: 'usd',
        redeem_by: Math.floor(new Date(discountData.endDate).getTime() / 1000)
      };

      if (discountData.discountType === 'Percentage') {
        coupondata.percent_off = discountData.percentage;
      } else {
        coupondata.amount_off = discountData.maxDiscount * 100; // Convert to cents
      }

      const newCoupon = await stripe.coupons.create(coupondata);
      console.log('New coupon created in Stripe:', newCoupon);
      return newCoupon;
    } catch (error) {
      console.error('Error updating coupon:', error);
      throw new Error(error);
    }
  },
  deleteCoupon: async (params) => {
    const { couponCode } = params;
    try {
      const deletedCoupon = await stripe.coupons.del(couponCode);
      console.log(`Coupon ${couponCode} deleted from Stripe`);
      return deletedCoupon;
    } catch (error) {
      console.error('Error deleting coupon:', error);
      throw new Error(error);
    }
  }
};
