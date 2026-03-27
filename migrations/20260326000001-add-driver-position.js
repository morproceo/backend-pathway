'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('applications', 'position', {
      type: Sequelize.ENUM('OO', 'LO', 'DR'),
      allowNull: false
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('applications', 'position', {
      type: Sequelize.ENUM('OO', 'LO'),
      allowNull: false
    });
  }
};
