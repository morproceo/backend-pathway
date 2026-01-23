'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('company_documents', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: 'Display name for the document'
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Optional description'
      },
      document_type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Type: mc_authority, w9, ucr, coi, etc.'
      },
      s3_key: {
        type: Sequelize.STRING(500),
        allowNull: false,
        comment: 'S3 object key'
      },
      original_filename: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      mime_type: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      file_size: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
        comment: 'Whether document is visible to drivers'
      },
      uploaded_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('company_documents', ['document_type']);
    await queryInterface.addIndex('company_documents', ['is_active']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('company_documents');
  }
};
