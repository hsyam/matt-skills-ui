# Checkout v2: Stripe PaymentIntents

## Problem Statement

Customers on 3-D Secure cards cannot finish checkout, and failed payments cannot be retried.

## Solution

Replace the legacy charge flow with PaymentIntents.

## User Stories

1. As a shopper, I want 3-D Secure to work, so that my card is accepted
2. As a shopper, I want to retry a failed payment, so that I don't lose my cart
3. As support, I want receipts emailed, so that customers stop asking

## Implementation Decisions

- PlaceOrder creates the PaymentIntent.
