/*
 Navicat Premium Data Transfer

 Source Server         : ssjnma_100
 Source Server Type    : MariaDB
 Source Server Version : 110410 (11.4.10-MariaDB-log)
 Source Host           : 192.168.88.100:3306
 Source Schema         : khups_kpi_db

 Target Server Type    : MariaDB
 Target Server Version : 110410 (11.4.10-MariaDB-log)
 File Encoding         : 65001

 Date: 11/03/2026 15:12:01
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for system_logs
-- ----------------------------
DROP TABLE IF EXISTS `system_logs`;
CREATE TABLE `system_logs`  (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NULL DEFAULT NULL,
  `dept_id` int(11) NULL DEFAULT NULL,
  `action_type` enum('INSERT','UPDATE','DELETE') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  `table_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  `record_id` int(11) NULL DEFAULT NULL,
  `old_value` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL CHECK (json_valid(`old_value`)),
  `new_value` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL CHECK (json_valid(`new_value`)),
  `ip_address` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  `user_agent` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 124 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of system_logs
-- ----------------------------
INSERT INTO `system_logs` VALUES (1, 6, NULL, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 148 รายการ\"}', '172.22.0.1', NULL, '2026-02-28 21:17:49');
INSERT INTO `system_logs` VALUES (2, 6, NULL, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 16 รายการ\"}', '172.22.0.1', NULL, '2026-02-28 22:46:43');
INSERT INTO `system_logs` VALUES (3, 1, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 17 รายการ\"}', '172.22.0.1', NULL, '2026-02-28 23:03:28');
INSERT INTO `system_logs` VALUES (4, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-02-28 23:09:48');
INSERT INTO `system_logs` VALUES (5, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":143,\"year_bh\":\"2569\",\"hospcode\":\"00018\",\"message\":\"ปลดล็อคข้อมูล\"}', '172.22.0.1', NULL, '2026-02-28 23:11:02');
INSERT INTO `system_logs` VALUES (6, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-01 00:23:37');
INSERT INTO `system_logs` VALUES (7, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-01 00:23:47');
INSERT INTO `system_logs` VALUES (8, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-01 00:23:51');
INSERT INTO `system_logs` VALUES (9, 4, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-01 10:32:30');
INSERT INTO `system_logs` VALUES (10, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-01 11:20:32');
INSERT INTO `system_logs` VALUES (11, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '223.206.48.251', NULL, '2026-03-01 12:36:48');
INSERT INTO `system_logs` VALUES (12, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 22:49:23');
INSERT INTO `system_logs` VALUES (13, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":30,\"year_bh\":\"2569\",\"hospcode\":\"00018\",\"message\":\"ปลดล็อคข้อมูล\"}', '172.22.0.1', NULL, '2026-03-02 22:49:41');
INSERT INTO `system_logs` VALUES (14, 6, NULL, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 16 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 22:50:08');
INSERT INTO `system_logs` VALUES (15, 6, NULL, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 16 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 22:50:21');
INSERT INTO `system_logs` VALUES (16, 6, NULL, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 148 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 22:51:32');
INSERT INTO `system_logs` VALUES (17, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 22:57:15');
INSERT INTO `system_logs` VALUES (18, 1, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 18 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 22:59:50');
INSERT INTO `system_logs` VALUES (19, 1, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 18 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:00:21');
INSERT INTO `system_logs` VALUES (20, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:01:16');
INSERT INTO `system_logs` VALUES (21, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":61,\"year_bh\":\"2569\",\"hospcode\":\"00018\",\"message\":\"ปลดล็อคข้อมูล\"}', '172.22.0.1', NULL, '2026-03-02 23:01:45');
INSERT INTO `system_logs` VALUES (22, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:04:34');
INSERT INTO `system_logs` VALUES (23, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:04:37');
INSERT INTO `system_logs` VALUES (24, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:04:44');
INSERT INTO `system_logs` VALUES (25, 6, NULL, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:12:14');
INSERT INTO `system_logs` VALUES (26, 1, 13, 'UPDATE', 'users', 6, NULL, '{\"username\":\"takio1981\",\"role\":\"super_admin\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-02 23:14:32');
INSERT INTO `system_logs` VALUES (27, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:37:27');
INSERT INTO `system_logs` VALUES (28, 6, 13, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":31,\"year_bh\":\"2569\",\"hospcode\":\"00018\",\"message\":\"ปลดล็อคข้อมูล\"}', '172.22.0.1', NULL, '2026-03-02 23:39:47');
INSERT INTO `system_logs` VALUES (29, 6, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:40:01');
INSERT INTO `system_logs` VALUES (30, 2, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:49:41');
INSERT INTO `system_logs` VALUES (31, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-02 23:57:02');
INSERT INTO `system_logs` VALUES (32, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:00:56');
INSERT INTO `system_logs` VALUES (33, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:04:03');
INSERT INTO `system_logs` VALUES (34, 5, 8, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:08:46');
INSERT INTO `system_logs` VALUES (35, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:11:09');
INSERT INTO `system_logs` VALUES (36, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:13:32');
INSERT INTO `system_logs` VALUES (37, 1, 13, 'UPDATE', 'users', 2, NULL, '{\"username\":\"hos00018\",\"role\":\"user\",\"password_changed\":false}', '172.22.0.1', NULL, '2026-03-03 00:15:06');
INSERT INTO `system_logs` VALUES (38, 1, 13, 'UPDATE', 'users', 2, NULL, '{\"username\":\"hos00018\",\"role\":\"user\",\"password_changed\":false}', '172.22.0.1', NULL, '2026-03-03 00:26:46');
INSERT INTO `system_logs` VALUES (39, 1, 13, 'UPDATE', 'users', 2, NULL, '{\"username\":\"hos00018\",\"role\":\"user\",\"password_changed\":false}', '172.22.0.1', NULL, '2026-03-03 00:27:32');
INSERT INTO `system_logs` VALUES (40, 1, 13, 'UPDATE', 'users', 2, NULL, '{\"username\":\"hos00018\",\"role\":\"user\",\"password_changed\":false}', '172.22.0.1', NULL, '2026-03-03 00:28:18');
INSERT INTO `system_logs` VALUES (41, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:32:32');
INSERT INTO `system_logs` VALUES (42, 2, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:33:54');
INSERT INTO `system_logs` VALUES (43, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:38:19');
INSERT INTO `system_logs` VALUES (44, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:51:29');
INSERT INTO `system_logs` VALUES (45, 2, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:52:32');
INSERT INTO `system_logs` VALUES (46, 2, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 00:54:52');
INSERT INTO `system_logs` VALUES (47, 2, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 2 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:20:01');
INSERT INTO `system_logs` VALUES (48, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:21:42');
INSERT INTO `system_logs` VALUES (49, 2, 6, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":136,\"year_bh\":\"2569\",\"hospcode\":\"00018\",\"message\":\"แก้ไขแล้วครับ\"}', '172.22.0.1', NULL, '2026-03-03 01:24:56');
INSERT INTO `system_logs` VALUES (50, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:25:08');
INSERT INTO `system_logs` VALUES (51, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:26:06');
INSERT INTO `system_logs` VALUES (52, 2, 6, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":133,\"year_bh\":\"2569\",\"hospcode\":\"00018\",\"message\":\"รับทราบแก้ไขทันที\"}', '172.22.0.1', NULL, '2026-03-03 01:28:15');
INSERT INTO `system_logs` VALUES (53, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:28:51');
INSERT INTO `system_logs` VALUES (54, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:50:17');
INSERT INTO `system_logs` VALUES (55, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:50:48');
INSERT INTO `system_logs` VALUES (56, 4, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:54:41');
INSERT INTO `system_logs` VALUES (57, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:55:19');
INSERT INTO `system_logs` VALUES (58, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:55:37');
INSERT INTO `system_logs` VALUES (59, 4, 13, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":158,\"year_bh\":\"2569\",\"hospcode\":\"10877\",\"message\":\"รพศ/รพท ทุกแห่งผ่านการรับรองมาตรฐาน ISO 27001\\nก.พ.: 11 → 12, มี.ค.: 0 → 2\"}', '172.22.0.1', NULL, '2026-03-03 01:57:07');
INSERT INTO `system_logs` VALUES (60, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:58:06');
INSERT INTO `system_logs` VALUES (61, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 01:59:21');
INSERT INTO `system_logs` VALUES (62, 2, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 06:56:38');
INSERT INTO `system_logs` VALUES (63, 2, 6, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":133,\"year_bh\":\"2569\",\"hospcode\":\"00018\",\"message\":\"แก้ไขแล้ว\"}', '172.22.0.1', NULL, '2026-03-03 06:56:38');
INSERT INTO `system_logs` VALUES (64, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 06:56:58');
INSERT INTO `system_logs` VALUES (65, 1, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:00:30');
INSERT INTO `system_logs` VALUES (66, 1, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:00:48');
INSERT INTO `system_logs` VALUES (67, 6, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:04:58');
INSERT INTO `system_logs` VALUES (68, 6, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:15:14');
INSERT INTO `system_logs` VALUES (69, 5, 8, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:17:11');
INSERT INTO `system_logs` VALUES (70, 6, 13, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":141,\"year_bh\":\"2569\",\"hospcode\":\"10877\",\"message\":\"ปลดล็อคข้อมูล\"}', '172.22.0.1', NULL, '2026-03-03 07:22:16');
INSERT INTO `system_logs` VALUES (71, 6, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:23:19');
INSERT INTO `system_logs` VALUES (72, 4, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:24:07');
INSERT INTO `system_logs` VALUES (73, 6, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:30:37');
INSERT INTO `system_logs` VALUES (74, 4, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 07:52:49');
INSERT INTO `system_logs` VALUES (75, 4, 13, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":141,\"year_bh\":\"2569\",\"hospcode\":\"10877\",\"message\":\"แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว\"}', '172.22.0.1', NULL, '2026-03-03 07:53:19');
INSERT INTO `system_logs` VALUES (76, 4, 13, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":158,\"year_bh\":\"2569\",\"hospcode\":\"10877\",\"message\":\"แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว\"}', '172.22.0.1', NULL, '2026-03-03 07:54:51');
INSERT INTO `system_logs` VALUES (77, 6, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 188 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 08:04:03');
INSERT INTO `system_logs` VALUES (78, 4, 13, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":141,\"year_bh\":\"2569\",\"hospcode\":\"10877\",\"message\":\"แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว\"}', '172.22.0.1', NULL, '2026-03-03 08:31:47');
INSERT INTO `system_logs` VALUES (79, 6, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 188 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 08:52:57');
INSERT INTO `system_logs` VALUES (80, 6, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 09:57:19');
INSERT INTO `system_logs` VALUES (81, 6, 13, 'UPDATE', 'users', 1, NULL, '{\"username\":\"admin_korat\",\"role\":\"admin\",\"password_changed\":false}', '172.22.0.1', NULL, '2026-03-03 10:01:22');
INSERT INTO `system_logs` VALUES (82, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 4 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:03:32');
INSERT INTO `system_logs` VALUES (83, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 4 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:05:12');
INSERT INTO `system_logs` VALUES (84, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 188 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:05:41');
INSERT INTO `system_logs` VALUES (85, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 10 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:09:13');
INSERT INTO `system_logs` VALUES (86, 6, 13, 'INSERT', 'users', 7, NULL, '{\"username\":\"hos10875\",\"role\":\"user\"}', '172.22.0.1', NULL, '2026-03-03 10:12:27');
INSERT INTO `system_logs` VALUES (87, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 10 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:12:44');
INSERT INTO `system_logs` VALUES (88, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 10 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:13:21');
INSERT INTO `system_logs` VALUES (89, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 10 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:14:08');
INSERT INTO `system_logs` VALUES (90, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 9 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:15:15');
INSERT INTO `system_logs` VALUES (91, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 10 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:15:42');
INSERT INTO `system_logs` VALUES (92, 1, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 188 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:30:13');
INSERT INTO `system_logs` VALUES (93, 1, 6, 'UPDATE', 'users', 1, NULL, '{\"username\":\"admin_korat\",\"role\":\"admin\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 10:37:16');
INSERT INTO `system_logs` VALUES (94, 1, 6, 'INSERT', 'kpi_results', NULL, NULL, '{\"message\":\"KPI-Setup: เขียนทับทั้งหมด 7 ตัวชี้วัด\"}', '172.22.0.1', NULL, '2026-03-03 10:41:07');
INSERT INTO `system_logs` VALUES (95, 4, 13, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 7 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:43:44');
INSERT INTO `system_logs` VALUES (96, 1, 6, 'INSERT', 'kpi_results', NULL, NULL, '{\"message\":\"KPI-Setup: เขียนทับทั้งหมด 7 ตัวชี้วัด\"}', '172.22.0.1', NULL, '2026-03-03 10:44:35');
INSERT INTO `system_logs` VALUES (97, 1, 6, 'UPDATE', 'users', 4, NULL, '{\"username\":\"hos10877\",\"role\":\"user\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 10:54:18');
INSERT INTO `system_logs` VALUES (98, 4, 12, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 4 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 10:55:20');
INSERT INTO `system_logs` VALUES (99, 1, 6, 'UPDATE', 'users', 1, NULL, '{\"username\":\"admin_korat\",\"role\":\"admin\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 11:08:22');
INSERT INTO `system_logs` VALUES (100, 1, 13, 'UPDATE', 'users', 1, NULL, '{\"username\":\"admin_korat\",\"role\":\"admin\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 11:10:30');
INSERT INTO `system_logs` VALUES (101, 1, 12, 'UPDATE', 'users', 1, NULL, '{\"username\":\"admin_korat\",\"role\":\"admin\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 11:11:02');
INSERT INTO `system_logs` VALUES (102, 1, 6, 'UPDATE', 'users', 4, NULL, '{\"username\":\"hos10877\",\"role\":\"user\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 11:12:12');
INSERT INTO `system_logs` VALUES (103, 4, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 5 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 11:13:13');
INSERT INTO `system_logs` VALUES (104, 7, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 3 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 11:14:27');
INSERT INTO `system_logs` VALUES (105, 1, 6, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 11:14:44');
INSERT INTO `system_logs` VALUES (106, 7, 6, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":12,\"year_bh\":\"2569\",\"hospcode\":\"10875\",\"message\":\"แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว\"}', '172.22.0.1', NULL, '2026-03-03 11:15:10');
INSERT INTO `system_logs` VALUES (107, 7, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 11:20:56');
INSERT INTO `system_logs` VALUES (108, 7, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 11:21:11');
INSERT INTO `system_logs` VALUES (109, 4, 6, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 11:55:42');
INSERT INTO `system_logs` VALUES (110, 4, 6, 'INSERT', 'kpi_results', NULL, NULL, '{\"message\":\"KPI-Setup: เพิ่มเฉพาะที่ยังไม่มี 5 ตัวชี้วัด (ข้าม 0 ที่มีอยู่แล้ว)\"}', '172.22.0.1', NULL, '2026-03-03 12:13:20');
INSERT INTO `system_logs` VALUES (111, 1, 6, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 12:14:17');
INSERT INTO `system_logs` VALUES (112, 4, 6, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":12,\"year_bh\":\"2569\",\"hospcode\":\"10877\",\"message\":\"แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว\"}', '172.22.0.1', NULL, '2026-03-03 12:17:55');
INSERT INTO `system_logs` VALUES (113, 1, 6, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 12:18:43');
INSERT INTO `system_logs` VALUES (114, 8, 1, 'INSERT', 'users', 8, NULL, '{\"username\":\"admin10877\",\"action\":\"self_register\"}', '172.22.0.1', NULL, '2026-03-03 13:03:53');
INSERT INTO `system_logs` VALUES (115, 8, 1, 'INSERT', 'kpi_results', NULL, NULL, '{\"message\":\"KPI-Setup: เพิ่มเฉพาะที่ยังไม่มี 11 ตัวชี้วัด (ข้าม 0 ที่มีอยู่แล้ว)\"}', '172.22.0.1', NULL, '2026-03-03 13:05:53');
INSERT INTO `system_logs` VALUES (116, 6, 13, 'UPDATE', 'users', 1, NULL, '{\"username\":\"admin_korat\",\"role\":\"admin_ssj\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 14:39:53');
INSERT INTO `system_logs` VALUES (117, 6, 13, 'UPDATE', 'users', 8, NULL, '{\"username\":\"admin10877\",\"role\":\"admin_cup\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 14:40:15');
INSERT INTO `system_logs` VALUES (118, 6, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"อนุมัติและล็อคข้อมูล 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 15:10:24');
INSERT INTO `system_logs` VALUES (119, 6, 13, '', 'kpi_results', NULL, NULL, '{\"count\":1,\"message\":\"ส่งคืนแก้ไข 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 15:10:32');
INSERT INTO `system_logs` VALUES (120, 6, 13, 'UPDATE', 'users', 4, NULL, '{\"username\":\"hos10877\",\"role\":\"user\",\"password_changed\":true}', '172.22.0.1', NULL, '2026-03-03 15:13:39');
INSERT INTO `system_logs` VALUES (121, 4, 12, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 15:14:34');
INSERT INTO `system_logs` VALUES (122, 4, 12, '', 'kpi_results', NULL, NULL, '{\"indicator_id\":166,\"year_bh\":\"2569\",\"hospcode\":\"10877\",\"message\":\"แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว\"}', '172.22.0.1', NULL, '2026-03-03 15:14:34');
INSERT INTO `system_logs` VALUES (123, 4, 12, 'UPDATE', 'kpi_results', NULL, NULL, '{\"message\":\"บันทึก KPI 1 รายการ\"}', '172.22.0.1', NULL, '2026-03-03 15:14:50');

SET FOREIGN_KEY_CHECKS = 1;
