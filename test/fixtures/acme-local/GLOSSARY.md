# Storefront

The shop customers buy from.

## Language

**Order**:
A placed, immutable purchase.
_Avoid_: cart, basket

**PaymentIntent**:
Stripe object tracking one attempt to collect payment for an Order.
_Avoid_: charge, payment

**Listing**:
A product as shown in one storefront: locale copy plus price.
_Avoid_: item, product page
