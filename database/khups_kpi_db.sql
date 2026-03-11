/*
 Navicat Premium Data Transfer

 Source Server         : localhost-windows
 Source Server Type    : MariaDB
 Source Server Version : 101114 (10.11.14-MariaDB)
 Source Host           : localhost:3306
 Source Schema         : khups_kpi_db

 Target Server Type    : MariaDB
 Target Server Version : 101114 (10.11.14-MariaDB)
 File Encoding         : 65001

 Date: 11/03/2026 15:07:43
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for system_logs
-- ----------------------------
DROP TABLE IF EXISTS `system_logs`;
CREATE TABLE `system_logs`  (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 1 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_general_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of system_logs
-- ----------------------------

SET FOREIGN_KEY_CHECKS = 1;
