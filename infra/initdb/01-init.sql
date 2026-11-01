-- Runs once, on first start of an empty data volume.
create extension if not exists vector;
create extension if not exists pgcrypto;
create database eia_test;
\connect eia_test
create extension if not exists vector;
create extension if not exists pgcrypto;
