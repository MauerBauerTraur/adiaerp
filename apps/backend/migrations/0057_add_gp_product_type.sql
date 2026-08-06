-- Migration 0057: Add 'gp' (Г/П, ready product) to product_type enum
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'gp';
